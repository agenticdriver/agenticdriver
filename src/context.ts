import { createHash, randomUUID } from "node:crypto";
import { abortable, DriverError } from "./errors.js";
import {
  ContextAttachmentSchema,
  ContextManifestSchema,
  type ContextAttachment,
  type ContextInput,
  type ContextManifest,
  type ContextReference,
  type ArtifactRequest,
  type DraftArtifact,
} from "./context-types.js";
import type { ExecutionContext, Json } from "./types.js";
export * from "./context-types.js";

const HARD_BYTES = 32 * 1024 * 1024;
const INLINE_BYTES = 512 * 1024;
export interface ContextLease {
  attachment: ContextAttachment;
  expiresAt?: string;
  /** Release app-owned temporary resources. Called once, including late cancellation. */
  release?(): Promise<void> | void;
}
/** The app must authorize this exact reference/revision against context.subject before returning content. */
export type ContextResolver = (
  reference: ContextReference,
  context: ExecutionContext,
) => Promise<ContextLease> | ContextLease;
export interface ContextOptions {
  resolve?: ContextResolver;
  maxBytes?: number;
  maxTextBytes?: number;
}
export function contextPolicy(options: ContextOptions = {}) {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024,
    maxTextBytes = options.maxTextBytes ?? 1_000_000;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > HARD_BYTES ||
    !Number.isSafeInteger(maxTextBytes) ||
    maxTextBytes < 1 ||
    maxTextBytes > 1_000_000
  )
    throw new DriverError(
      "INVALID_CONTEXT_POLICY",
      "Context limits must be positive integers within 32 MiB total and 1000000 text bytes.",
    );
  return { resolve: options.resolve, maxBytes, maxTextBytes };
}
const digest = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
function attachmentBytes(
  attachment: ContextAttachment,
  maxBytes = HARD_BYTES,
): Buffer {
  const location = attachment.source.location;
  if (
    (location?.pageEnd !== undefined &&
      (location.page === undefined || location.pageEnd < location.page)) ||
    (location?.endLine !== undefined &&
      (location.startLine === undefined ||
        location.endLine < location.startLine))
  )
    throw new DriverError(
      "INVALID_CONTEXT",
      "Source locations must have consistent start and end positions.",
    );
  if (attachment.source.uri) {
    let uri: URL;
    try {
      uri = new URL(attachment.source.uri);
    } catch {
      throw new DriverError(
        "INVALID_CONTEXT",
        "Source metadata contains an invalid URI.",
      );
    }
    if (uri.username || uri.password)
      throw new DriverError(
        "INVALID_CONTEXT",
        "Source URIs cannot contain credentials.",
      );
  }
  if (attachment.type === "text") {
    if (Buffer.byteLength(attachment.text) > maxBytes)
      throw new DriverError(
        "CONTEXT_TOO_LARGE",
        "The attachment exceeds its content budget.",
      );
    return Buffer.from(attachment.text, "utf8");
  }
  if (attachment.data.length > Math.ceil(maxBytes / 3) * 4)
    throw new DriverError(
      "CONTEXT_TOO_LARGE",
      "The attachment exceeds its content budget.",
    );
  if (
    attachment.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data)
  )
    throw new DriverError(
      "INVALID_CONTEXT",
      "Binary attachments require canonical base64 data.",
    );
  const data = Buffer.from(attachment.data, "base64");
  if (data.length > maxBytes)
    throw new DriverError(
      "CONTEXT_TOO_LARGE",
      "The attachment exceeds its content budget.",
    );
  if (!data.length || data.toString("base64") !== attachment.data)
    throw new DriverError(
      "INVALID_CONTEXT",
      "Binary attachments require canonical base64 data.",
    );
  const signature =
    attachment.mediaType === "application/pdf"
      ? data.subarray(0, 5).toString("ascii") === "%PDF-"
      : attachment.mediaType === "image/png"
        ? data
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : attachment.mediaType === "image/jpeg"
          ? data[0] === 255 && data[1] === 216 && data[2] === 255
          : data.subarray(0, 4).toString("ascii") === "RIFF" &&
            data.subarray(8, 12).toString("ascii") === "WEBP";
  if (!signature)
    throw new DriverError(
      "INVALID_CONTEXT",
      "Attachment bytes do not match the declared media type.",
    );
  return data;
}
function checked(input: ContextAttachment, maxBytes = HARD_BYTES) {
  const parsed = ContextAttachmentSchema.safeParse(input);
  if (!parsed.success)
    throw new DriverError(
      "INVALID_CONTEXT",
      "The attachment does not match the supported context schema.",
    );
  return {
    attachment: parsed.data,
    bytes: attachmentBytes(parsed.data, maxBytes),
  };
}
/** Synchronous inline preflight, before idempotency acceptance or provider work. */
export function validateInlineContext(inputs: ContextInput[]) {
  let total = 0;
  const ids = new Set<string>();
  for (const input of inputs) {
    const id = input.type === "reference" ? input.id : input.source.id;
    if (ids.has(id))
      throw new DriverError(
        "INVALID_CONTEXT",
        "Context source IDs must be unique within a run.",
      );
    ids.add(id);
    if (input.type !== "reference") {
      const { bytes } = checked(input, 256 * 1024);
      total += bytes.length;
      if (bytes.length > 256 * 1024 || total > INLINE_BYTES)
        throw new DriverError(
          "CONTEXT_TOO_LARGE",
          "Inline attachments are limited to 256 KiB each and 512 KiB total; use application-owned references for larger documents.",
        );
    }
  }
}

export async function resolveContext(
  inputs: ContextInput[],
  options: ContextOptions,
  context: ExecutionContext,
) {
  const policy = contextPolicy(options),
    leases: ContextLease[] = [];
  let closed = false,
    total = 0,
    textBytes = 0;
  const attachments: ContextAttachment[] = [],
    sources: ContextManifest[] = [];
  const releaseOne = async (lease: ContextLease) => {
    try {
      await abortable(
        Promise.resolve().then(() => lease.release?.()),
        AbortSignal.timeout(1000),
      );
    } catch {
      /* Bounded resource cleanup must not replace an execution outcome. */
    }
  };
  const release = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled(leases.splice(0).map(releaseOne));
  };
  try {
    for (const input of inputs) {
      context.signal.throwIfAborted();
      let lease: ContextLease;
      if (input.type === "reference") {
        if (!policy.resolve)
          throw new DriverError(
            "CONTEXT_UNAVAILABLE",
            "This host has no application context resolver.",
          );
        const pending = Promise.resolve()
          .then(() => policy.resolve!(input, context))
          .then((value) => {
            if (closed) void releaseOne(value);
            else leases.push(value);
            return value;
          });
        try {
          lease = await abortable(pending, context.signal);
        } catch (error) {
          if (error instanceof DriverError || context.signal.aborted)
            throw error;
          throw new DriverError(
            "CONTEXT_UNAVAILABLE",
            "The application could not resolve the selected context.",
          );
        }
      } else {
        lease = { attachment: input };
      }
      context.signal.throwIfAborted();
      const { attachment, bytes } = checked(
        lease.attachment,
        policy.maxBytes - total,
      );
      if (
        input.type === "reference" &&
        (attachment.source.id !== input.id ||
          attachment.source.revision !== input.revision ||
          attachment.mediaType !== input.mediaType)
      )
        throw new DriverError(
          "CONTEXT_CHANGED",
          "The application reference no longer matches the selected revision or media type.",
        );
      if (
        lease.expiresAt !== undefined &&
        (!Number.isFinite(Date.parse(lease.expiresAt)) ||
          Date.parse(lease.expiresAt) <= Date.now())
      )
        throw new DriverError(
          "CONTEXT_EXPIRED",
          "The selected context has expired.",
        );
      total += bytes.length;
      if (attachment.type === "text") textBytes += bytes.length;
      if (total > policy.maxBytes || textBytes > policy.maxTextBytes)
        throw new DriverError(
          "CONTEXT_TOO_LARGE",
          "The resolved context exceeds the host's content budget.",
        );
      sources.push(
        ContextManifestSchema.parse({
          ...attachment.source,
          mediaType: attachment.mediaType,
          bytes: bytes.length,
          sha256: digest(bytes),
          origin: input.type === "reference" ? "reference" : "inline",
          ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {}),
        }),
      );
      attachments.push(attachment);
      context.reportProgress();
    }
    return { attachments, sources, release };
  } catch (error) {
    await release();
    throw error;
  }
}

export function draftArtifact(
  request: ArtifactRequest,
  text: string,
  output: Json | undefined,
  sources: ContextManifest[],
): DraftArtifact {
  const content =
    request.mediaType === "application/json" ? JSON.stringify(output) : text;
  if (content === undefined || Buffer.byteLength(content) > 262_144)
    throw new DriverError(
      "ARTIFACT_TOO_LARGE",
      "Draft artifacts require content within 256 KiB.",
    );
  return {
    ...request,
    id: randomUUID(),
    status: "draft",
    content,
    sha256: digest(content),
    sourceIds: sources.map((source) => source.id),
  };
}

/** Optional app-owned ephemeral storage. Every insertion specifies subjects and an expiry. */
export class MemoryContextStore {
  private readonly entries = new Map<
    string,
    {
      attachment: ContextAttachment;
      subjects: Set<string>;
      expiresAt: string;
      bytes: number;
      sha256: string;
    }
  >();
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  constructor(options: { maxBytes?: number; maxEntries?: number } = {}) {
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 1000;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      this.maxBytes > HARD_BYTES ||
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 1 ||
      this.maxEntries > 10_000
    )
      throw new DriverError(
        "INVALID_CONTEXT_POLICY",
        "Memory context storage requires bounded positive byte and entry limits.",
      );
  }
  private schedule() {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (!this.entries.size) return;
    const remaining =
      Math.min(
        ...[...this.entries.values()].map((entry) =>
          Date.parse(entry.expiresAt),
        ),
      ) - Date.now();
    this.expiryTimer = setTimeout(
      () => {
        this.purge();
        this.schedule();
      },
      Math.max(1, Math.min(remaining, 2_147_483_647)),
    );
    this.expiryTimer.unref();
  }
  private purge() {
    for (const [id, entry] of this.entries)
      if (Date.parse(entry.expiresAt) <= Date.now()) this.entries.delete(id);
  }
  put(input: {
    attachment: ContextAttachment;
    subjects: readonly string[];
    expiresAt: string;
  }): ContextReference {
    this.purge();
    const { attachment, bytes } = checked(input.attachment);
    if (
      !input.subjects.length ||
      input.subjects.length > 1000 ||
      input.subjects.some(
        (subject) =>
          typeof subject !== "string" || !subject || subject.length > 128,
      ) ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      Date.parse(input.expiresAt) <= Date.now()
    )
      throw new DriverError(
        "INVALID_CONTEXT_POLICY",
        "Stored content requires explicit authorized subjects and a future expiry.",
      );
    const old = this.entries.get(attachment.source.id),
      sha256 = digest(bytes);
    if (
      old?.attachment.source.revision === attachment.source.revision &&
      (old.sha256 !== sha256 ||
        JSON.stringify(old.attachment.source) !==
          JSON.stringify(attachment.source) ||
        old.attachment.mediaType !== attachment.mediaType)
    )
      throw new DriverError(
        "CONTEXT_CONFLICT",
        "The existing source revision identifies different content; assign a new revision.",
      );
    const used =
      [...this.entries.values()].reduce((sum, value) => sum + value.bytes, 0) -
      (old?.bytes ?? 0);
    if (
      (!old && this.entries.size >= this.maxEntries) ||
      used + bytes.length > this.maxBytes
    )
      throw new DriverError(
        "CONTEXT_CAPACITY",
        "The application context store has reached its configured capacity.",
      );
    this.entries.set(attachment.source.id, {
      attachment,
      subjects: new Set(input.subjects),
      expiresAt: new Date(input.expiresAt).toISOString(),
      bytes: bytes.length,
      sha256,
    });
    this.schedule();
    return {
      type: "reference",
      id: attachment.source.id,
      revision: attachment.source.revision,
      mediaType: attachment.mediaType,
    };
  }
  delete(id: string) {
    const removed = this.entries.delete(id);
    this.schedule();
    return removed;
  }
  clear() {
    this.entries.clear();
    this.schedule();
  }
  readonly resolve: ContextResolver = (reference, context) => {
    context.signal.throwIfAborted();
    this.purge();
    const entry = this.entries.get(reference.id);
    if (!entry || !entry.subjects.has(context.subject))
      throw new DriverError(
        "CONTEXT_NOT_FOUND",
        "The selected context is unavailable to this subject.",
      );
    if (
      entry.attachment.source.revision !== reference.revision ||
      entry.attachment.mediaType !== reference.mediaType
    )
      throw new DriverError(
        "CONTEXT_CHANGED",
        "The selected source revision or media type has changed.",
      );
    return {
      attachment: structuredClone(entry.attachment),
      expiresAt: entry.expiresAt,
    };
  };
}

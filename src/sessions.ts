import { randomUUID } from "node:crypto";
import { DriverError } from "./errors.js";
import {
  SessionCreateSchema,
  SessionIdentitySchema,
  SessionOptionsSchema,
  type SessionCreate,
  type SessionIdentity,
  type SessionInfo,
  type SessionSnapshot,
  type SessionDeleteResult,
  type SessionOperation,
  type SessionOptions,
  type PortableMessage,
} from "./session-types.js";
import type { ProviderInfo, ProviderMessage, RunRequest } from "./types.js";

export interface SessionPrincipal {
  subject?: string;
  providers?: readonly string[];
  sessions?: readonly SessionOperation[];
}
interface AccountBinding {
  hostId: string;
  accountId?: string;
}
interface Record {
  info: SessionInfo;
  subject: string;
  account: AccountBinding;
  history: PortableMessage[];
  instructions?: string;
  messages: ProviderMessage[];
  timer?: ReturnType<typeof setTimeout>;
  active?: AbortController;
}
export interface SessionLease {
  messages: ProviderMessage[];
  instructions?: string;
  signal: AbortSignal;
  started(): void;
  check(messages: ProviderMessage[]): void;
  commit(messages: ProviderMessage[], input: string, text: string): SessionInfo;
  release(): void;
}
function jsonState(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach(jsonState);
    return;
  }
  if (
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    for (const item of Object.values(value))
      if (item !== undefined) jsonState(item);
    return;
  }
  throw new Error("Provider state must be JSON");
}
const failure = (code: string, message: string) =>
  new DriverError(code, message);

/** Explicit, process-local conversations. Provider state never leaves this manager. */
export class SessionManager {
  private readonly records = new Map<string, Record>();
  private readonly options?: SessionOptions;
  constructor(
    options: SessionOptions | undefined,
    private readonly account: (
      provider: string,
      subject: string,
    ) => AccountBinding,
    private readonly provider: (provider: string) => ProviderInfo,
  ) {
    if (options !== undefined) {
      const parsed = SessionOptionsSchema.safeParse(options);
      if (!parsed.success)
        throw failure(
          "INVALID_SESSION_CONFIG",
          "Session policy requires explicit idle retention and valid storage limits.",
        );
      this.options = parsed.data;
    }
  }
  get enabled() {
    return this.options !== undefined;
  }
  private configured(): SessionOptions {
    if (!this.options)
      throw failure(
        "SESSIONS_UNAVAILABLE",
        "This host has not enabled conversation storage.",
      );
    return this.options;
  }
  private permitted(
    principal: SessionPrincipal,
    operation: SessionOperation,
    provider: string,
  ) {
    if (
      (principal.providers && !principal.providers.includes(provider)) ||
      (principal.sessions && !principal.sessions.includes(operation))
    )
      throw failure(
        "FORBIDDEN",
        "This token cannot perform this conversation operation.",
      );
  }
  private binding(provider: string, subject: string): AccountBinding {
    const account = this.account(provider, subject);
    if (!account.accountId)
      throw failure(
        "SESSION_ACCOUNT_REQUIRED",
        "Conversation storage requires a host-owned account binding for this provider instance.",
      );
    return { hostId: account.hostId, accountId: account.accountId };
  }
  private checkBinding(record: Record) {
    const account = this.binding(record.info.provider, record.subject);
    if (
      account.accountId !== record.account.accountId ||
      account.hostId !== record.account.hostId
    )
      throw failure(
        "SESSION_ACCOUNT_CHANGED",
        "This conversation belongs to a different provider account binding.",
      );
  }
  private lookup(
    input: SessionIdentity,
    principal: SessionPrincipal,
    operation: SessionOperation,
  ) {
    this.configured();
    const identity = SessionIdentitySchema.safeParse(input);
    if (!identity.success)
      throw failure(
        "INVALID_SESSION",
        "The conversation identity does not match the schema.",
      );
    const record = this.records.get(identity.data.id);
    if (
      record &&
      !record.active &&
      Date.parse(record.info.expiresAt!) <= Date.now()
    )
      this.remove(record);
    if (
      !record ||
      !this.records.has(record.info.id) ||
      record.subject !== (principal.subject ?? "local")
    )
      throw failure(
        "SESSION_NOT_FOUND",
        "No conversation is available to this subject.",
      );
    this.permitted(principal, operation, record.info.provider);
    if (operation !== "delete") this.checkBinding(record);
    return record;
  }
  private remove(record: Record) {
    clearTimeout(record.timer);
    this.records.delete(record.info.id);
    record.active?.abort(
      failure(
        "SESSION_DELETED",
        "The conversation was deleted while this turn was running.",
      ),
    );
    // Active turns own separate snapshots; their cancellation releases those too.
    record.history = [];
    record.messages = [];
    record.instructions = undefined;
  }
  private expireLater(record: Record) {
    clearTimeout(record.timer);
    const retention = this.configured().retentionMs;
    record.info.expiresAt = new Date(Date.now() + retention).toISOString();
    record.timer = setTimeout(() => this.remove(record), retention);
    record.timer.unref();
  }
  private snapshot(record: Record): SessionSnapshot {
    return structuredClone({
      session: record.info,
      history: record.history,
      ...(record.instructions === undefined
        ? {}
        : { instructions: record.instructions }),
    });
  }
  private checkSize(
    history: PortableMessage[],
    messages: ProviderMessage[],
    instructions?: string,
  ) {
    const options = this.configured();
    // Native tool exchanges are bounded separately; public history remains portable.
    if (history.length > (options.maxMessages ?? 100) || messages.length > 2048)
      throw failure(
        "SESSION_CONTEXT_LIMIT",
        "The conversation reached its message limit. Export its visible history and explicitly start a smaller conversation.",
      );
    let encoded: string;
    try {
      jsonState({ history, messages, instructions });
      encoded = JSON.stringify({ history, messages, instructions });
    } catch {
      throw failure(
        "INVALID_SESSION_STATE",
        "The provider returned conversation state that cannot be stored as JSON.",
      );
    }
    if (Buffer.byteLength(encoded) > (options.maxRecordBytes ?? 1_000_000))
      throw failure(
        "SESSION_CONTEXT_LIMIT",
        "The conversation reached its byte limit. No history was silently truncated.",
      );
    if (history.some((message) => message.content.length > 100_000))
      throw failure(
        "SESSION_CONTEXT_LIMIT",
        "A visible conversation message exceeds the portable history limit.",
      );
  }
  create(
    input: SessionCreate,
    principal: SessionPrincipal = {},
  ): SessionSnapshot {
    const options = this.configured(),
      parsed = SessionCreateSchema.safeParse(input);
    if (!parsed.success)
      throw failure(
        "INVALID_SESSION",
        "The conversation creation request does not match the schema.",
      );
    const request = parsed.data;
    this.permitted(principal, "create", request.provider);
    const provider = this.provider(request.provider);
    if (
      provider.capabilities[
        request.mode === "native" ? "nativeContinuation" : "historyContinuation"
      ] !== true
    )
      throw failure(
        "UNSUPPORTED_CONTINUATION",
        "This provider does not support the selected conversation mode.",
      );
    if (provider.models && !provider.models.includes(request.model))
      throw failure(
        "UNSUPPORTED_MODEL",
        "The requested model is not allowed on this provider instance.",
      );
    const subject = principal.subject ?? "local",
      account = this.binding(request.provider, subject);
    for (const record of this.records.values())
      if (!record.active && Date.parse(record.info.expiresAt!) <= Date.now())
        this.remove(record);
    if (this.records.size >= (options.maxEntries ?? 1000))
      throw failure(
        "SESSION_CAPACITY",
        "Conversation storage is full; existing conversations were retained.",
      );
    const history = structuredClone(request.history ?? []),
      messages = structuredClone(history);
    this.checkSize(history, messages, request.instructions);
    const now = new Date().toISOString();
    const record: Record = {
      subject,
      account,
      history,
      messages,
      instructions: request.instructions,
      info: {
        id: randomUUID(),
        revision: 0,
        provider: request.provider,
        model: request.model,
        mode: request.mode,
        state: "ready",
        createdAt: now,
        updatedAt: now,
      },
    };
    this.records.set(record.info.id, record);
    this.expireLater(record);
    return this.snapshot(record);
  }
  read(
    input: SessionIdentity,
    principal: SessionPrincipal = {},
  ): SessionSnapshot {
    return this.snapshot(this.lookup(input, principal, "read"));
  }
  delete(
    input: SessionIdentity,
    principal: SessionPrincipal = {},
  ): SessionDeleteResult {
    const record = this.lookup(input, principal, "delete"),
      id = record.info.id;
    this.remove(record);
    return { id, deleted: true };
  }
  validate(request: RunRequest) {
    if (!request.session) return;
    this.configured();
    if (request.history !== undefined || request.instructions !== undefined)
      throw failure(
        "SESSION_HISTORY_CONFLICT",
        "A stored conversation owns its history and instructions. Start a new conversation to replace them.",
      );
    if (request.attachments?.length || request.retrieval)
      throw failure(
        "SESSION_CONTEXT_UNSUPPORTED",
        "Stored conversations currently accept text and application tools. Use application-owned history with freshly authorized attachments or retrieval.",
      );
  }
  /** Replayed outcomes still require current session access, but never reserve another turn. */
  authorizeReplay(request: RunRequest, principal: SessionPrincipal) {
    if (!request.session) return;
    const record = this.lookup(
      { id: request.session.id },
      principal,
      "continue",
    );
    this.selection(record, request);
  }
  private selection(record: Record, request: RunRequest) {
    if (
      record.info.provider !== request.provider ||
      record.info.model !== request.model
    )
      throw failure(
        "SESSION_PROVIDER_MISMATCH",
        "A conversation is bound to its provider account and model. Export visible history and explicitly create a new conversation to switch.",
      );
    if (
      this.provider(request.provider).capabilities[
        record.info.mode === "native"
          ? "nativeContinuation"
          : "historyContinuation"
      ] !== true
    )
      throw failure(
        "UNSUPPORTED_CONTINUATION",
        "This provider no longer supports the selected continuation mode.",
      );
  }
  begin(
    request: RunRequest,
    principal: SessionPrincipal,
  ): SessionLease | undefined {
    if (!request.session) return;
    this.validate(request);
    const record = this.lookup(
      { id: request.session.id },
      principal,
      "continue",
    );
    this.selection(record, request);
    if (record.info.revision !== request.session.revision)
      throw failure(
        "SESSION_REVISION_CONFLICT",
        "This conversation has advanced; read its current revision before continuing.",
      );
    if (record.info.state === "running")
      throw failure(
        "SESSION_BUSY",
        "Another turn is already running in this conversation.",
      );
    if (record.info.state === "interrupted")
      throw failure(
        "SESSION_INTERRUPTED",
        "The previous turn was interrupted. Reconcile its outcome before explicitly starting a replacement conversation.",
      );
    this.checkSize(
      [
        ...record.history,
        { role: "user", content: request.input },
        { role: "assistant", content: "" },
      ],
      [...record.messages, { role: "user", content: request.input }],
      record.instructions,
    );
    clearTimeout(record.timer);
    record.active = new AbortController();
    record.info.state = "running";
    delete record.info.expiresAt;
    const controller = record.active;
    let started = false,
      settled = false;
    const available = () => {
      if (settled)
        throw failure(
          "SESSION_INTERRUPTED",
          "This conversation turn is already closed.",
        );
      if (
        controller.signal.aborted ||
        this.records.get(record.info.id) !== record
      )
        throw failure(
          "SESSION_DELETED",
          "The conversation was deleted while this turn was running.",
        );
    };
    return {
      messages: structuredClone(record.messages),
      instructions: record.instructions,
      signal: controller.signal,
      started() {
        started = true;
      },
      check: (messages) => {
        available();
        this.checkSize(record.history, messages, record.instructions);
      },
      commit: (messages, input, text) => {
        available();
        this.checkBinding(record);
        const history: PortableMessage[] = [
          ...record.history,
          { role: "user", content: input },
          { role: "assistant", content: text },
        ];
        const retained = record.info.mode === "native" ? messages : history;
        this.checkSize(history, retained, record.instructions);
        const snapshot = JSON.parse(
          JSON.stringify({ history, messages: retained }),
        ) as { history: PortableMessage[]; messages: ProviderMessage[] };
        record.history = snapshot.history;
        record.messages = snapshot.messages;
        record.info.revision++;
        record.info.state = "ready";
        record.info.updatedAt = new Date().toISOString();
        record.active = undefined;
        this.expireLater(record);
        settled = true;
        return structuredClone(record.info);
      },
      release: () => {
        if (settled || this.records.get(record.info.id) !== record) return;
        settled = true;
        record.active = undefined;
        record.info.state = started ? "interrupted" : "ready";
        record.info.updatedAt = new Date().toISOString();
        this.expireLater(record);
      },
    };
  }
}

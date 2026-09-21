/** Trusted startup/build step. Never pass request parameters into this loader. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, sep } from "node:path";
import { DriverError } from "./errors.js";
import {
  providerAssetSchema,
  type IconVariant,
  type ProviderAsset,
} from "./catalog.js";
import { providerSchema, type UsageStatProvider } from "./usagestat-types.js";

export interface ProviderAssetApproval {
  providerId: string;
  variant: IconVariant;
  license: { id: string; attribution: string; noticePath: string };
}
export interface ProviderAssetCache {
  /** Safe for browser serialization: contains no local paths or upstream URLs. */
  manifest: ProviderAsset[];
  missing: {
    providerId: string;
    variant: IconVariant;
    reason:
      | "provider-missing"
      | "variant-missing"
      | "file-missing"
      | "remote-icon"
      | "unsupported-format";
  }[];
  /** Exact, immutable route lookup. Performs no filesystem reads or upstream requests. */
  respond(request: Request): Response | undefined;
}
const formats = {
  svg: "image/svg+xml",
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
} as const;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export async function createProviderAssetCache(options: {
  providers: readonly UsageStatProvider[];
  /** A trusted local Usagestat plugins directory, never a browser-supplied path. */
  root: string;
  allowlist: readonly ProviderAssetApproval[];
  /** Same-origin route prefix, without queries, credentials, escapes or dot segments. */
  publicPath?: string;
}): Promise<ProviderAssetCache> {
  const publicPath = options.publicPath ?? "/assets/usagestat";
  if (
    !/^\/(?!\/)[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(publicPath) ||
    publicPath.length > 200 ||
    options.allowlist.length > 256
  )
    throw new DriverError(
      "ASSET_CONFIG",
      "Use a bounded catalog allowlist and an absolute same-origin asset path.",
    );
  let root: string;
  try {
    root = await realpath(options.root);
  } catch {
    throw new DriverError(
      "ASSET_CONFIG",
      "The approved Usagestat plugin directory is unavailable.",
    );
  }
  if (root === parse(root).root)
    throw new DriverError(
      "ASSET_CONFIG",
      "Select a specific plugin directory for provider assets.",
    );
  const cache = new Map<
    string,
    { body: Uint8Array; type: string; hash: string }
  >();
  const manifest: ProviderAsset[] = [];
  const missing: ProviderAssetCache["missing"] = [];
  const seen = new Set<string>();
  async function bytes(
    path: string,
    limit: number,
  ): Promise<Uint8Array | undefined> {
    let canonical: string;
    try {
      canonical = await realpath(isAbsolute(path) ? path : join(root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new DriverError(
        "ASSET_READ",
        "A reviewed asset could not be resolved.",
      );
    }
    const local = relative(root, canonical);
    if (
      !local ||
      local === ".." ||
      local.startsWith(`..${sep}`) ||
      isAbsolute(local)
    )
      throw new DriverError(
        "ASSET_SCOPE",
        "A catalog asset or notice is outside the approved plugin directory.",
      );
    try {
      const file = await open(
        canonical,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > limit)
          throw new DriverError(
            "ASSET_SIZE",
            "Assets must be nonempty regular files within the configured size bound.",
          );
        const result = new Uint8Array(limit + 1);
        let size = 0;
        while (size < result.length) {
          const { bytesRead } = await file.read(
            result,
            size,
            result.length - size,
            null,
          );
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (!size || size > limit)
          throw new DriverError(
            "ASSET_SIZE",
            "An asset exceeded its size bound while loading.",
          );
        return result.slice(0, size);
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof DriverError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new DriverError(
        "ASSET_READ",
        "A reviewed asset could not be read.",
      );
    }
  }
  function add(body: Uint8Array, extension: string, type: string) {
    const hash = digest(body);
    const path = `${publicPath}/${hash}.${extension}`;
    cache.set(path, { body, type, hash });
    return { path, hash };
  }
  for (const approval of options.allowlist) {
    const key = JSON.stringify([approval.providerId, approval.variant]);
    if (
      seen.has(key) ||
      !approval.providerId ||
      !["monochrome", "color"].includes(approval.variant)
    )
      throw new DriverError(
        "ASSET_CONFIG",
        "Approve each named provider variant once.",
      );
    seen.add(key);
    const candidates = options.providers.filter(
      (p) => p.id === approval.providerId,
    );
    if (candidates.length > 1)
      throw new DriverError(
        "ASSET_CONFIG",
        "Provider catalog identities must be unique.",
      );
    const absent = (reason: ProviderAssetCache["missing"][number]["reason"]) =>
      missing.push({
        providerId: approval.providerId,
        variant: approval.variant,
        reason,
      });
    if (!candidates[0]) {
      absent("provider-missing");
      continue;
    }
    const parsed = providerSchema.safeParse(candidates[0]);
    if (!parsed.success)
      throw new DriverError(
        "ASSET_CONFIG",
        "The selected provider has invalid icon metadata.",
      );
    const icon = parsed.data.icon;
    if (!icon) {
      absent("variant-missing");
      continue;
    }
    if (icon.kind === "url" || icon.url) {
      absent("remote-icon");
      continue;
    }
    const variant = icon.variants?.[approval.variant];
    const path =
      variant?.path ??
      (approval.variant === "color"
        ? icon.colorPath
        : (icon.monochromePath ?? icon.path));
    if (!path) {
      absent("variant-missing");
      continue;
    }
    const format =
      variant?.kind ?? (approval.variant === "color" ? "svg" : icon.kind);
    if (!Object.hasOwn(formats, format)) {
      absent("unsupported-format");
      continue;
    }
    const body = await bytes(path, 256 * 1024);
    if (!body) {
      absent("file-missing");
      continue;
    }
    // These are reviewed assets, not an upload sanitizer. Basic signatures catch
    // mislabeled files; CSP and image embedding constrain document execution.
    const text =
      format === "svg"
        ? new TextDecoder("utf-8", { fatal: true }).decode(body)
        : "";
    if (
      (format === "svg" && !/<svg(?:\s|>)/.test(text)) ||
      (format === "png" &&
        !Buffer.from(body.subarray(0, 8)).equals(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        )) ||
      (format === "jpeg" &&
        (body[0] !== 255 || body[1] !== 216 || body[2] !== 255)) ||
      (format === "webp" &&
        (Buffer.from(body.subarray(0, 4)).toString() !== "RIFF" ||
          Buffer.from(body.subarray(8, 12)).toString() !== "WEBP"))
    )
      throw new DriverError(
        "ASSET_FORMAT",
        "A reviewed icon does not match its declared image format.",
      );
    const notice = await bytes(approval.license.noticePath, 256 * 1024);
    if (!notice)
      throw new DriverError(
        "ASSET_LICENSE",
        "Each served icon requires its upstream license notice.",
      );
    const image = add(body, format, formats[format as keyof typeof formats]);
    const license = add(notice, "txt", "text/plain; charset=utf-8");
    const monochrome =
      variant?.monochrome ??
      (approval.variant === "monochrome" && icon.monochrome === true);
    const value = providerAssetSchema.safeParse({
      providerId: approval.providerId,
      variant: approval.variant,
      src: image.path,
      sha256: image.hash,
      mediaType: formats[format as keyof typeof formats],
      monochrome,
      supportsCurrentColor:
        format === "svg" &&
        monochrome &&
        (variant?.supportsCurrentColor ?? icon.supportsCurrentColor) === true,
      license: {
        id: approval.license.id,
        attribution: approval.license.attribution,
        noticeUrl: license.path,
      },
    });
    if (!value.success)
      throw new DriverError(
        "ASSET_LICENSE",
        "Approved assets require complete attribution and license metadata.",
      );
    manifest.push(value.data);
  }
  return {
    manifest,
    missing,
    respond(request) {
      const url = new URL(request.url);
      if (url.search || url.hash || !["GET", "HEAD"].includes(request.method))
        return undefined;
      const value = cache.get(url.pathname);
      if (!value) return undefined;
      const etag = `"sha256-${value.hash}"`;
      const headers = {
        "Content-Type": value.type,
        ETag: etag,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      };
      if (request.headers.get("if-none-match") === etag)
        return new Response(null, { status: 304, headers });
      return new Response(
        request.method === "HEAD" ? null : new Uint8Array(value.body),
        { headers },
      );
    },
  };
}

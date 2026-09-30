import type {
  ProviderRuntimeRequest,
  ProviderRuntimeSnapshot,
} from "./runtime-types.js";

// Kept independent of Zod so the shared browser component does not bundle server schemas.
export function matchesRuntimeResponse(
  value: unknown,
  request: ProviderRuntimeRequest,
): value is ProviderRuntimeSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as ProviderRuntimeSnapshot;
  if (
    snapshot.version !== 1 ||
    !Array.isArray(snapshot.runtimes) ||
    snapshot.runtimes.length !== 1
  )
    return false;
  const r = snapshot.runtimes[0];
  if (
    !r ||
    r.kind !== request.kind ||
    r.version !== "0.157.0" ||
    r.platform !== "linux-x64" ||
    ![
      "missing",
      "downloading",
      "verifying",
      "installed",
      "failed",
      "cancelled",
    ].includes(r.phase)
  )
    return false;
  const uuid =
    /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$/;
  const text = (s: unknown, maximum: number): s is string =>
    typeof s === "string" && s.length > 0 && s.length <= maximum;
  const active = r.phase === "downloading" || r.phase === "verifying";
  return (
    typeof r.archiveSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(r.archiveSha256) &&
    typeof r.canCancel === "boolean" &&
    Number.isSafeInteger(r.downloadBytes) &&
    Number.isSafeInteger(r.totalBytes) &&
    r.totalBytes > 0 &&
    r.downloadBytes >= 0 &&
    r.downloadBytes <= r.totalBytes &&
    (!["installed", "verifying"].includes(r.phase) ||
      r.downloadBytes === r.totalBytes) &&
    (r.phase === "installed" ? text(r.binary, 4096) : r.binary === undefined) &&
    (r.id === undefined || (typeof r.id === "string" && uuid.test(r.id))) &&
    (!active || Boolean(r.id)) &&
    (!r.canCancel || active) &&
    (r.updatedAt === undefined ||
      (typeof r.updatedAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(r.updatedAt) &&
        Number.isFinite(Date.parse(r.updatedAt)))) &&
    (r.error === undefined ||
      (r.error && text(r.error.code, 80) && text(r.error.message, 512))) &&
    (request.action !== "cancel" || r.id === request.id)
  );
}

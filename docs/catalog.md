# Provider identity, icons and quota displays

AgenticDriver reuses Usagestat's catalog and account quota API. It does not add provider probes, copy the logo collection into this package, or turn quota differences into per-run usage. The same helpers support Brandstorm's account picker, LitAgent's provider settings and AI Workspace's connection/account UI. Each application keeps its own layout, authenticated sessions, account bindings and workflows.

| Entry                                | Where it runs                 | Responsibility                                                               |
| ------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------- |
| `@agenticdriver/sdk/catalog`         | Browser or server             | Pure provider and quota presentation, accessible names and fallback states   |
| `@agenticdriver/sdk/usagestat`       | Trusted application server    | Existing metadata and explicitly bound quota reads; optional per-run capture |
| `@agenticdriver/sdk/provider-assets` | Trusted Node.js startup/build | Load approved existing icons/notices into an immutable asset cache           |

## Provider and account identity

Use a provider from the authenticated driver's discovery response. Match its explicit `usageStatId` to Usagestat's provider ID; do not join names, guess vendor aliases or use an account quota ID as a branding ID. The helper rejects mismatched metadata.

```ts
import { providerPresentation } from "@agenticdriver/sdk/catalog";

// providers: authorized driver discovery; metadata: server-side Usagestat catalog.
const selected = providers.find((p) => p.id === selectedProviderId)!;
const card = providerPresentation(selected, {
  metadata: metadata.find((p) => p.id === selected.usageStatId),
  account: { id: binding.accountId, label: binding.displayName },
  assets: assetCache.manifest,
  variant: "monochrome", // or explicitly "color"
});
```

`binding` is the application's trusted mapping for this provider and user. Never infer it from a provider logo, email address in a usage message, or request metadata. The result keeps the driver instance ID, account ID/label and provider identity separate. `accessibleName` includes the account label and instance ID so two Codex accounts remain distinguishable. Missing account labels display “Account not linked”; the helper does not invent an account.

Render names, labels and attribution as text. For `card.icon.kind === "asset"`, use an `<img>` with `src={card.icon.asset.src}` and `alt={card.icon.alt}`; include the license notice link in your app's attribution UI. A fallback contains an initial, accessible name and reason (`metadata-missing`, `icon-missing`, or `variant-missing`). An unavailable requested variant does not silently switch styles. When adjacent text already names the provider, the app may mark the icon decorative and put `accessibleName` on the enclosing choice.

`monochrome` and `supportsCurrentColor` preserve source metadata. An external SVG loaded with `<img>` does not inherit the page's `currentColor`; these flags do not promise automatic tinting. Prefer the reviewed color variant or an app-owned neutral background. Do not inject raw SVG as HTML. The returned card omits local source paths, upstream image URLs, raw metadata and quota credentials.

## Account-scoped quota freshness

Configure [Usagestat account bindings](usagestat.md) on the trusted server. Only pass `accountLimits(identity)` results to the presentation helper. Raw `usage()` and `limits()` are administrative data and must not be sent wholesale to browsers.

```ts
import { quotaPresentation } from "@agenticdriver/sdk/catalog";
import type { UsageStatAccountQuota } from "@agenticdriver/sdk/catalog";

// Derive all four values from the authenticated session and host configuration.
const identity = {
  hostId,
  provider: selected.id,
  accountId,
  subject: session.userId,
};
let quota: UsageStatAccountQuota | undefined;
let error: unknown;
try {
  quota = await usagestat.accountLimits(identity);
} catch (failure) {
  error = failure;
}
const display = quotaPresentation(identity, quota, {
  maxAgeMs: 5 * 60_000, // Explicit application display policy, not a run timeout.
  error,
});
```

The helper verifies the full host/provider/account/subject identity before showing any metrics. It is a display helper, not an authorization boundary: the server must enforce the session and bindings before lookup. Send the resulting display to that user only. A failed refresh suppresses an older successful result; exceptions are converted to fixed labels without exposing upstream error messages.

| State         | Display behavior                                                                            |
| ------------- | ------------------------------------------------------------------------------------------- |
| `fresh`       | Snapshot age is below the application's limit and its reported reset windows have not ended |
| `stale`       | Show the previous values as historical; refresh is required                                 |
| `unbound`     | No account binding, or a receipt belongs to another identity; no metrics                    |
| `unavailable` | No snapshot or quota metrics reported; no fabricated zeros                                  |
| `error`       | Quota refresh failed; no metrics or private error details                                   |
| `unknown`     | Invalid/future timestamp or invalid metrics; no metrics                                     |

Also display `quality`: `cached`, `estimated`, `reported` or `unknown`. A recently fetched cached or estimated observation remains labelled as such. `fresh` describes time, not certainty or permission to execute. Use the provided label plus `fetchedAt`/`ageMs`; preserve the upstream units and reset timestamps. Passing a reset boundary never fabricates a reset-to-zero balance. Resources remain snapshots, not exact run charges, budget authorization, or guaranteed remaining capacity. Per-run accounting continues through the existing [usage contract](usage.md).

## Serve reviewed Usagestat assets

Build the cache on the same trusted filesystem as the selected Usagestat catalog. The allowlist belongs in application/deployment configuration, never in an HTTP request. Review the installed source assets and notices when pinning your Usagestat dependency.

```ts
import { createProviderAssetCache } from "@agenticdriver/sdk/provider-assets";

const assetCache = await createProviderAssetCache({
  providers: await usagestat.providers(),
  root: "/opt/usagestat/plugins",
  publicPath: "/assets/usagestat",
  allowlist: ["codex", "claude", "gemini"].flatMap((providerId) =>
    (["monochrome", "color"] as const).map((variant) => ({
      providerId,
      variant,
      license: {
        id: "MIT",
        attribution:
          "Usagestat upstream notices; provider marks belong to their owners.",
        noticePath: "UPSTREAM-LICENSES.md",
      },
    })),
  ),
});

// Mount this in your app's existing same-origin Fetch/Request router.
function providerAssetRoute(request: Request): Response {
  return assetCache.respond(request) ?? new Response(null, { status: 404 });
}
```

The existing Usagestat `plugins/UPSTREAM-LICENSES.md` records upstream MIT notices for adapted assets, including CodexBar, OpenUsage and CrossUsage, and notes that provider names/logos belong to their owners. The cache serves the notice bytes unchanged and links them from each approved asset. Approval metadata is supplied by the operator; the SDK cannot establish the provenance of a newly added third-party asset. Supply its actual notice and attribution when expanding the allowlist.

The loader selects paths only from the approved provider/variant catalog entries, resolves symlinks and rejects paths outside the configured plugin root. Images and notices are bounded to 256 KiB each, with at most 256 approved variants. Unsupported, missing or remote-URL icons become explicit `missing` entries for fallback display. Missing notices, invalid metadata, oversized files and paths outside the root fail cache creation. No remote image URL is fetched.

Assets are read once, hashed and served only through exact manifest URLs. Requests cannot choose filenames, change variants, add queries or trigger filesystem reads. GET/HEAD, ETags, immutable cache headers, MIME types, `nosniff`, a sandbox CSP and `no-referrer` are supplied; preserve these headers in your framework/proxy. These are public reviewed branding assets, never account snapshots or credentials. Mount this route narrowly and keep account APIs authenticated.

Use `<img>` with the resulting URLs. The loader checks image signatures but is not an SVG upload sanitizer. The approved plugin directory and catalog are trusted operator inputs; applications must not let users replace files there. An asset change creates a new content hash after the cache is rebuilt, while existing cache objects keep serving their original bytes. Deploy the matching manifest and cache together.

For a remote Usagestat installation, prepare the cache alongside that installation and expose only its approved asset routes through the application's asset proxy, or stage the reviewed assets/notices through your build pipeline. Preserve the same manifest/hash URLs and headers. A remote catalog's absolute filesystem path is not a usable browser URL or a local file path on another server. Do not implement a `?path=` file reader, open image proxy, credential-bearing URL, or browser access to the raw administrative catalog.

Usagestat is optional: if metadata/assets or quotas are unavailable, use the helper's fallback states while the chosen execution provider retains its own availability checks. Application setup work is tracked in AD-033 (Brandstorm), AD-035 (LitAgent) and AD-037 (AI Workspace); these helpers do not migrate their account/session storage.

## Verification

`tests/catalog.test.ts` covers identity, freshness, errors, variants, notices, caching and path boundaries. `npm run test:install` checks the installed catalog entry's DOM-only declarations and browser bundle without Node/server imports. To check actual native metadata and existing assets:

```sh
npx tsx scripts/test-usagestat-assets.ts /path/to/usagestatd /path/to/usagestat/plugins
```

That check copies the native executable and three provider packages into an isolated temporary profile, disables every provider probe, then verifies catalog metadata, icon bytes and upstream notices. It does not use real accounts or certify live quota accuracy.

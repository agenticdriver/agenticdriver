import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  providerPresentation,
  quotaPresentation,
  type UsageStatAccountQuota,
  type UsageStatProvider,
} from "../src/catalog.js";
import { createProviderAssetCache } from "../src/provider-assets.js";
import { UsageStatClient } from "../src/usagestat.js";
import type { ProviderInfo } from "../src/types.js";
import { DriverError } from "../src/errors.js";

const provider: ProviderInfo = {
  id: "codex-personal",
  name: "Codex",
  vendor: "openai",
  authMode: "cli-session",
  usageStatId: "codex",
  capabilities: { tools: false, textStreaming: true },
};
const metadata: UsageStatProvider = {
  id: "codex",
  name: "Codex",
  icon: {
    kind: "svg",
    path: "/never/expose/path",
    monochrome: true,
    supportsCurrentColor: true,
  },
  brandColor: "#123456",
};
const identity = {
  hostId: "host-one",
  provider: provider.id,
  accountId: "account-one",
  subject: "user-one",
};
const now = Date.parse("2026-09-21T10:00:00Z");
const receipt: UsageStatAccountQuota = {
  identity,
  upstreamInstanceId: "codex-personal",
  snapshot: {
    displayName: "Personal Codex",
    fetchedAt: "2026-09-21T09:59:00Z",
    source: "oauth",
    resources: {
      session: {
        label: "Session",
        used: 20,
        limit: 100,
        remaining: 80,
        utilization: 0.2,
        unit: "percent",
        resetsAt: "2026-09-21T11:00:00Z",
      },
    },
  },
};
const policy = { now, maxAgeMs: 300_000 };
const code = (expected: string) => (e: unknown) =>
  e instanceof DriverError && e.code === expected;

test("provider display preserves exact instance and account identity with accessible icon fallbacks", () => {
  for (const app of ["Brandstorm", "LitAgent", "AI Workspace"]) {
    const card = providerPresentation(provider, {
      metadata,
      account: { id: `${app}-personal`, label: "Personal" },
    });
    assert.equal(card.providerId, "codex-personal");
    assert.equal(card.accountLabel, "Personal");
    assert.equal(card.accessibleName, "Codex · Personal (codex-personal)");
    assert.equal(card.brandColor, "#123456");
    assert.deepEqual(card.icon, {
      kind: "fallback",
      text: "C",
      alt: "Codex",
      reason: "icon-missing",
    });
    assert.ok(!JSON.stringify(card).includes("/never/expose"));
  }
  assert.notEqual(
    providerPresentation(provider).accessibleName,
    providerPresentation({ ...provider, id: "codex-work" }).accessibleName,
  );
  assert.equal(
    providerPresentation(provider).accountLabel,
    "Account not linked",
  );
  const account = {
    id: "account-one",
    label: "Personal",
    token: "must-stay-private",
  };
  assert.ok(
    !JSON.stringify(providerPresentation(provider, { account })).includes(
      account.token,
    ),
  );
  assert.throws(
    () =>
      providerPresentation(provider, {
        metadata: { id: "claude", name: "Wrong" },
      }),
    code("CATALOG_MISMATCH"),
  );
  assert.equal(
    providerPresentation(provider, {
      metadata: { ...metadata, brandColor: "url(https://bad.example)" },
    }).brandColor,
    undefined,
  );
});

test("quota freshness retains observation quality, historical metrics and passed reset windows", () => {
  const current = quotaPresentation(identity, receipt, policy);
  assert.equal(current.state, "fresh");
  assert.equal(current.quality, "reported");
  assert.equal(current.observation, "quota-snapshot");
  assert.equal(current.ageMs, 60_000);
  assert.equal(current.resources[0]?.remaining, 80);
  const stale = quotaPresentation(identity, receipt, {
    ...policy,
    maxAgeMs: 60_000,
  });
  assert.equal(stale.state, "stale");
  assert.equal(stale.resources[0]?.used, 20);
  for (const [source, quality, label] of [
    ["cached", "cached", "Cached quota snapshot"],
    ["local-estimate", "estimated", "Estimated quota snapshot"],
  ]) {
    const view = quotaPresentation(
      identity,
      { ...receipt, snapshot: { ...receipt.snapshot, source } },
      policy,
    );
    assert.equal(view.quality, quality);
    assert.equal(view.label, label);
  }
  const reset = structuredClone(receipt);
  reset.snapshot.resources.session!.resetsAt = "2026-09-21T09:59:59Z";
  const view = quotaPresentation(identity, reset, policy);
  assert.equal(view.state, "stale");
  assert.match(view.label, /window ended/);
  assert.equal(view.resources[0]?.used, 20);
  assert.ok(!("inputTokens" in current));
  assert.ok(!("costUsd" in current));
});

test("quota errors, missing data, uncertain timestamps and cross-account receipts never fabricate available quota", () => {
  for (const key of ["hostId", "provider", "accountId", "subject"] as const) {
    const wrong = structuredClone(receipt);
    wrong.identity[key] += "-other";
    const view = quotaPresentation(identity, wrong, policy);
    assert.equal(view.state, "unbound");
    assert.deepEqual(view.resources, []);
  }
  assert.equal(
    quotaPresentation(identity, undefined, policy).state,
    "unavailable",
  );
  assert.equal(
    quotaPresentation(identity, receipt, {
      ...policy,
      error: new DriverError("QUOTA_UNBOUND", "Private path /secret"),
    }).state,
    "unbound",
  );
  for (const error of [
    new Error("secret-token"),
    new DriverError("QUOTA_UNAVAILABLE", "private account"),
  ]) {
    const view = quotaPresentation(identity, receipt, { ...policy, error });
    assert.equal(view.state, "error");
    assert.deepEqual(view.resources, []);
    assert.ok(!JSON.stringify(view).includes(error.message));
  }
  for (const fetchedAt of [
    "tomorrow",
    "2026-09-21T10:01:00Z",
    "2026-09-21T09:59:00",
  ]) {
    assert.equal(
      quotaPresentation(
        identity,
        { ...receipt, snapshot: { ...receipt.snapshot, fetchedAt } },
        policy,
      ).state,
      "unknown",
    );
  }
  assert.equal(
    quotaPresentation(
      identity,
      { ...receipt, snapshot: { ...receipt.snapshot, source: "error" } },
      policy,
    ).state,
    "error",
  );
  assert.equal(
    quotaPresentation(
      identity,
      { ...receipt, snapshot: { ...receipt.snapshot, resources: {} } },
      policy,
    ).state,
    "unavailable",
  );
  assert.throws(
    () => quotaPresentation(identity, receipt, { ...policy, maxAgeMs: 0 }),
    code("QUOTA_DISPLAY_POLICY"),
  );
});

test("app quota presentation consumes the existing subject-scoped Usagestat lookup without provider fallback", async () => {
  const calls: string[] = [];
  const backend = new UsageStatClient({
    accounts: [
      {
        hostId: identity.hostId,
        provider: identity.provider,
        accountId: identity.accountId,
        instanceId: receipt.upstreamInstanceId,
        subjects: [identity.subject],
      },
    ],
    fetch: async (url) => {
      calls.push(String(url));
      return Response.json({
        schema: "crossusage.limits.v1",
        providers: { [receipt.upstreamInstanceId]: receipt.snapshot },
        errors: [],
      });
    },
  });
  const view = quotaPresentation(
    identity,
    await backend.accountLimits(identity),
    policy,
  );
  assert.equal(view.state, "fresh");
  assert.deepEqual(calls, ["http://127.0.0.1:6736/v1/limits/codex-personal"]);
  await assert.rejects(
    backend.accountLimits({ ...identity, subject: "other" }),
    code("QUOTA_UNBOUND"),
  );
  assert.equal(calls.length, 1);
});

async function assetFixture() {
  const dir = await mkdtemp(join(tmpdir(), "sdk-provider-assets-"));
  const root = join(dir, "plugins");
  await mkdir(join(root, "codex"), { recursive: true });
  await writeFile(
    join(root, "codex/icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M0 0h10v10H0z"/></svg>',
  );
  await writeFile(
    join(root, "codex/icon-color.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#f00" d="M0 0h10v10H0z"/></svg>',
  );
  await writeFile(
    join(root, "NOTICE.txt"),
    "Synthetic test asset. MIT. Fixture author.",
  );
  const providers: UsageStatProvider[] = [
    {
      ...metadata,
      icon: {
        kind: "svg",
        path: join(root, "codex/icon.svg"),
        colorPath: join(root, "codex/icon-color.svg"),
        monochrome: true,
        supportsCurrentColor: true,
      },
    },
  ];
  const license = {
    id: "MIT",
    attribution: "Fixture author",
    noticePath: "NOTICE.txt",
  };
  const allowlist = (["monochrome", "color"] as const).map((variant) => ({
    providerId: "codex",
    variant,
    license,
  }));
  return { dir, root, providers, allowlist };
}

test("approved icon variants carry notices and immutable cache routes without exposing source paths", async () => {
  const f = await assetFixture();
  try {
    const assets = await createProviderAssetCache(f);
    assert.equal(assets.manifest.length, 2);
    assert.deepEqual(assets.missing, []);
    for (const asset of assets.manifest) {
      const card = providerPresentation(provider, {
        metadata,
        assets: assets.manifest,
        variant: asset.variant,
      });
      assert.equal(card.icon.kind, "asset");
      assert.equal(card.icon.alt, "Codex");
      assert.ok(!JSON.stringify(card).includes(f.root));
      const url = "https://app.example" + asset.src;
      const res = assets.respond(new Request(url))!;
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Content-Type"), "image/svg+xml");
      assert.match(res.headers.get("Cache-Control")!, /immutable/);
      assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
      assert.match(res.headers.get("Content-Security-Policy")!, /sandbox/);
      const original = await res.text();
      assert.match(original, /<svg/);
      assert.equal(
        assets.respond(
          new Request(url, {
            headers: { "if-none-match": res.headers.get("etag")! },
          }),
        )?.status,
        304,
      );
      assert.equal(
        await assets.respond(new Request(url, { method: "HEAD" }))?.text(),
        "",
      );
      const notice = assets.respond(
        new Request("https://app.example" + asset.license.noticeUrl),
      )!;
      assert.equal(
        await notice.text(),
        "Synthetic test asset. MIT. Fixture author.",
      );
      await unlink(
        join(
          f.root,
          asset.variant === "color" ? "codex/icon-color.svg" : "codex/icon.svg",
        ),
      );
      assert.equal(
        await assets.respond(new Request(url))!.text(),
        original,
        "reads are cached, never request-time filesystem access",
      );
    }
    for (const path of [
      "/etc/passwd",
      "/assets/usagestat/../NOTICE.txt",
      "/assets/usagestat/%2e%2e/NOTICE.txt",
      assets.manifest[0]!.src + "?path=/secret",
    ])
      assert.equal(
        assets.respond(new Request("https://app.example" + path)),
        undefined,
      );
    assert.equal(
      assets.respond(
        new Request("https://app.example" + assets.manifest[0]!.src, {
          method: "POST",
        }),
      ),
      undefined,
    );
    const noColor = providerPresentation(provider, {
      metadata,
      assets: [assets.manifest[0]!],
      variant: "color",
    });
    assert.equal(noColor.icon.kind, "fallback");
    for (const src of [
      "https://user:secret@evil.example/icon.svg",
      "//evil.example/icon.svg",
      "data:image/svg+xml,x",
      "/assets/icon.svg?token=secret",
    ]) {
      assert.throws(
        () =>
          providerPresentation(provider, {
            metadata,
            assets: [{ ...assets.manifest[0]!, src }],
          }),
        code("INVALID_ASSET_MANIFEST"),
      );
    }
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("asset loading rejects escapes and missing notices while unsupported/missing icons have explicit fallback reasons", async () => {
  const f = await assetFixture();
  try {
    const secret = join(f.dir, "private.svg");
    await writeFile(secret, "private secret");
    await symlink(secret, join(f.root, "escape.svg"));
    for (const path of [secret, join(f.root, "escape.svg")]) {
      await assert.rejects(
        createProviderAssetCache({
          ...f,
          providers: [{ ...metadata, icon: { kind: "svg", path } }],
        }),
        code("ASSET_SCOPE"),
      );
    }
    await assert.rejects(
      createProviderAssetCache({
        ...f,
        allowlist: [
          {
            ...f.allowlist[0]!,
            license: { ...f.allowlist[0]!.license, noticePath: "missing.txt" },
          },
        ],
      }),
      code("ASSET_LICENSE"),
    );
    const remote = await createProviderAssetCache({
      ...f,
      providers: [
        {
          ...metadata,
          icon: { kind: "url", url: "https://secret@other.example/icon.svg" },
        },
      ],
    });
    assert.deepEqual(remote.manifest, []);
    assert.ok(remote.missing.every((m) => m.reason === "remote-icon"));
    const absent = await createProviderAssetCache({ ...f, providers: [] });
    assert.ok(absent.missing.every((m) => m.reason === "provider-missing"));
    await unlink(join(f.root, "codex/icon-color.svg"));
    const one = await createProviderAssetCache(f);
    assert.equal(one.manifest.length, 1);
    assert.equal(one.missing[0]?.reason, "file-missing");
    await writeFile(join(f.root, "codex/icon.svg"), "x".repeat(256 * 1024 + 1));
    await assert.rejects(createProviderAssetCache(f), code("ASSET_SIZE"));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

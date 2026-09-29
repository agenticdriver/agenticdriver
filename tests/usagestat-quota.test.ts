import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { z } from "zod";
import {
  UsageStatClient,
  limitsFromSnapshots,
  resourceSlug,
  type UsageStatAccountBinding,
  type UsageStatSnapshot,
} from "../src/usagestat.js";
import { snapshotSchema } from "../src/usagestat-types.js";
import type { ResourceAdmissionContext } from "../src/resources.js";

test("quota keys and empty reads do not create provider observations", () => {
  assert.equal(resourceSlug("Weekly (Sonnet)"), "weekly-sonnet");
  assert.equal(resourceSlug("—"), "resource");
  assert.equal(resourceSlug("__proto__"), "proto");
  const empty = limitsFromSnapshots([]);
  assert.equal(empty.schema, "agenticdriver.usagestat-limits.v1");
  assert.equal(Object.getPrototypeOf(empty.providers), null);
  assert.deepEqual(Object.keys(empty.providers), []);
  assert.deepEqual(empty.errors, []);
});

// Opt-in read-only qualification against the existing daemon. Every observation
// comes from a real HTTP response; no account, provider, or response is seeded.
// The private binding file supplies explicit administrative validation identities.
// These mappings are in memory only and do not provision an SDK execution host.
const url = process.env.USAGESTAT_URL;
const bindingsFile = process.env.USAGESTAT_BINDINGS_FILE;

test(
  "native Usagestat account snapshots drive scoped quota admission",
  {
    skip:
      !(url && bindingsFile) &&
      "set USAGESTAT_URL and USAGESTAT_BINDINGS_FILE for real account reads",
  },
  async () => {
    const accounts: UsageStatAccountBinding[] = JSON.parse(
      await readFile(bindingsFile!, "utf8"),
    );
    assert.ok(
      accounts.length > 0,
      "select existing backend instances explicitly",
    );
    const responses: { path: string; snapshots: UsageStatSnapshot[] }[] = [];
    let requests = 0;
    // Observe the actual reply without substituting its status, headers or body.
    const observe: typeof fetch = async (input, init) => {
      requests += 1;
      const path = new URL(String(input)).pathname;
      assert.ok(/\/v1\/usage(?:\/[^/]+)?$/.test(path));
      assert.equal(init?.redirect, "error");
      const response = await fetch(input, init);
      assert.equal(response.status, 200, "native usage route must exist");
      const body: unknown = await response.clone().json();
      responses.push({
        path,
        snapshots: Array.isArray(body)
          ? z.array(snapshotSchema).parse(body)
          : [snapshotSchema.parse(body)],
      });
      return response;
    };
    const client = new UsageStatClient({ url: url!, accounts, fetch: observe });
    const report = {
      checkedAt: new Date().toISOString(),
      accounts: accounts.length,
      snapshots: 0,
      ready: 0,
      unavailable: 0,
      failedWithCachedMetrics: 0,
      measuredResources: 0,
      allowed: 0,
      denied: 0,
      overCapRejected: 0,
      unknown: 0,
      unboundWithoutRequest: 0,
      modelCalls: 0,
      bindingsPersistedToHost: false,
    };
    const all = await client.limits();
    assert.equal(all.schema, "agenticdriver.usagestat-limits.v1");
    const observed = responses.at(-1)!.snapshots;
    report.snapshots = observed.length;
    assert.equal(Object.keys(all.providers).length, observed.length);
    for (const raw of observed) {
      const quota = all.providers[raw.providerId];
      assert.ok(quota, "each native instance retains its own quota entry");
      assert.equal(quota.fetchedAt, raw.fetchedAt);
      assert.equal(quota.source, raw.source ?? undefined);
      assert.equal(Object.getPrototypeOf(quota.resources), null);
    }
    for (const binding of accounts) {
      assert.ok(
        observed.some((s) => s.providerId === binding.instanceId),
        "selected instance must exist; do not substitute another account",
      );
      const identity = {
        hostId: binding.hostId,
        provider: binding.provider,
        accountId: binding.accountId,
        subject: binding.subjects[0]!,
      };
      // This invokes only the read-only guard, not an SDK run or model step.
      const context = {
        identity,
        signal: new AbortController().signal,
      } as ResourceAdmissionContext;
      const result = await client.accountLimits(identity).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      const response = responses.at(-1)!;
      assert.ok(
        response.path.endsWith(
          `/v1/usage/${encodeURIComponent(binding.instanceId)}`,
        ),
      );
      assert.equal(response.snapshots.length, 1);
      const raw = response.snapshots[0]!;
      assert.equal(raw.providerId, binding.instanceId);
      const failed =
        raw.source === "error" ||
        (raw.state != null && raw.state !== "ready") ||
        raw.metrics.some((m) => m.type === "badge" && m.label === "Error");
      if (failed) {
        assert.equal(
          (result.error as { code?: string })?.code,
          "QUOTA_UNAVAILABLE",
        );
        report.unavailable += 1;
        if (
          raw.source === "cached" &&
          raw.metrics.some((m) => m.type === "progress")
        )
          report.failedWithCachedMetrics += 1;
      } else {
        assert.ok(
          result.value,
          "a ready native account must provide scoped quota",
        );
        report.ready += 1;
        assert.equal(result.value.upstreamInstanceId, binding.instanceId);
        assert.equal(result.value.snapshot.fetchedAt, raw.fetchedAt);
        assert.equal(result.value.snapshot.source, raw.source ?? undefined);
        for (const value of Object.values(result.value.snapshot.resources)) {
          const metric = raw.metrics.find(
            (m) => m.type === "progress" && m.label === value.label,
          );
          assert.ok(
            metric,
            "derived resource must originate in the actual snapshot",
          );
          assert.equal(value.used, metric.used);
          assert.equal(value.resetsAt, metric.resetsAt ?? undefined);
          if (typeof metric.limit === "number" && metric.limit > 0) {
            assert.equal(value.limit, metric.limit);
            assert.equal(
              value.remaining,
              Math.max(0, metric.limit - value.used),
            );
          }
          report.measuredResources += 1;
        }
      }

      const resources =
        result.value?.snapshot.resources ??
        all.providers[binding.instanceId]!.resources;
      const entry = Object.entries(resources).find(
        ([, value]) => value.remaining !== undefined,
      );
      if (entry) {
        const [resource, value] = entry;
        const maxAgeMs = 3_600_000;
        const options = {
          resource,
          unit: value.unit,
          minimumRemaining: Number.MIN_VALUE,
          maxAgeMs,
          unknown: "reject" as const,
        };
        const decision = await client
          .quotaAdmission(options)
          .authorize(context);
        const current = responses.at(-1)!.snapshots[0]!;
        const derived = limitsFromSnapshots([current]);
        const latest =
          derived.providers[binding.instanceId]!.resources[resource];
        const age = Date.now() - Date.parse(current.fetchedAt);
        const usable =
          !derived.errors.length &&
          age >= 0 &&
          age < maxAgeMs &&
          latest?.unit === value.unit &&
          latest.remaining !== undefined &&
          (!latest.resetsAt || Date.parse(latest.resetsAt) > Date.now());
        const expected = usable
          ? latest.remaining! > 0
            ? "allow"
            : "deny"
          : "unknown";
        assert.equal(decision, expected);
        report[
          decision === "allow"
            ? "allowed"
            : decision === "deny"
              ? "denied"
              : "unknown"
        ] += 1;
        // A threshold higher than the observed positive cap must never allow.
        if (usable && latest.limit) {
          assert.notEqual(
            await client
              .quotaAdmission({
                ...options,
                minimumRemaining: latest.limit + 1,
              })
              .authorize(context),
            "allow",
          );
          report.overCapRejected += 1;
        }
        // Checking a nonexistent resource cannot borrow another quota window.
        let absent = "unconfigured-resource";
        while (Object.hasOwn(resources, absent)) absent += "-absent";
        assert.equal(
          await client
            .quotaAdmission({ ...options, resource: absent })
            .authorize(context),
          "unknown",
        );
        report.unknown += 1;
      }
      // Check a subject with no grant using this real instance; no HTTP request
      // may occur, even when observations are configured as allow-unknown.
      let unbound = "unauthorized-validation-subject";
      while (accounts.some((a) => a.subjects.includes(unbound)))
        unbound += "-absent";
      const before = requests;
      await assert.rejects(
        client.accountLimits({ ...identity, subject: unbound }),
        { code: "QUOTA_UNBOUND" },
      );
      await assert.rejects(
        Promise.resolve().then(() =>
          client
            .quotaAdmission({
              resource: "session",
              unit: "percent",
              minimumRemaining: 1,
              maxAgeMs: 3_600_000,
              unknown: "allow",
            })
            .authorize({
              ...context,
              identity: { ...identity, subject: unbound },
            }),
        ),
        { code: "QUOTA_UNBOUND" },
      );
      assert.equal(requests, before);
      report.unboundWithoutRequest += 1;
    }
    assert.ok(
      report.ready > 0 && report.measuredResources > 0,
      "qualification needs a real usable quota observation",
    );
    const receipt = { ...report, httpReads: requests };
    if (process.env.USAGESTAT_CHECK_REPORT)
      await writeFile(
        process.env.USAGESTAT_CHECK_REPORT,
        JSON.stringify(receipt, null, 2) + "\n",
        { mode: 0o600 },
      );
    console.log(JSON.stringify(receipt));
  },
);

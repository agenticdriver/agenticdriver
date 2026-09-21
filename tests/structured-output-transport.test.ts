import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AgenticClient } from "../src/client.js";
import { AgenticDriver } from "../src/driver.js";
import { DriverError } from "../src/errors.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";
import type { RunEvent, RunRequest } from "../src/types.js";

const command = promisify(execFile);
const token = "schema-transport-synthetic-test-token-only";
const request = { provider: "mock", model: "demo", input: "Propose a claim" };
const draft2020 = "https://json-schema.org/draft/2020-12/schema";
const draft07 = "http://json-schema.org/draft-07/schema#";
const tlsDirectory = process.env.AGENTICDRIVER_SCHEMA_TLS_FIXTURE;
const transport = tlsDirectory ? "HTTPS" : "HTTP";

// The composition is deliberate: unevaluatedProperties must recognize fields
// evaluated by allOf, while local refs and tuple positions still constrain them.
const proposalSchema = {
  $schema: draft2020,
  type: "object",
  $defs: {
    source: { type: "string", const: "selected-paper@r1" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  allOf: [
    {
      properties: {
        claim: { type: "string", minLength: 1 },
        evidence: {
          type: "array",
          prefixItems: [
            { $ref: "#/$defs/source" },
            { $ref: "#/$defs/confidence" },
          ],
          minItems: 2,
          items: false,
        },
      },
      required: ["claim", "evidence"],
    },
  ],
  unevaluatedProperties: false,
};
const proposal = {
  claim: "Synthetic storage evidence — résumé 🌍",
  evidence: ["selected-paper@r1", 0.75],
};
const legacySchema = {
  type: "object",
  definitions: { source: { type: "string", enum: ["selected-paper@r1"] } },
  properties: {
    evidence: {
      type: "array",
      items: [{ $ref: "#/definitions/source" }, { type: "integer" }],
      minItems: 2,
      additionalItems: false,
    },
  },
  required: ["evidence"],
  additionalProperties: false,
};

async function tlsFiles(directory: string) {
  return {
    cert: await readFile(join(directory, "cert.pem")),
    key: await readFile(join(directory, "key.pem")),
  };
}

async function host(text: string) {
  let calls = 0;
  const server = await serve(
    new AgenticDriver({
      providers: [
        mockProvider((_request, context) => {
          calls++;
          assert.equal(context.subject, "schema-user");
          return { text };
        }),
      ],
    }),
    {
      host: "127.0.0.1",
      port: 0,
      tokens: [{ token, subject: "schema-user", providers: ["mock"] }],
      ...(tlsDirectory ? { tls: await tlsFiles(tlsDirectory) } : {}),
    },
  );
  return {
    client: new AgenticClient({ url: server.url, token }),
    close: server.close,
    calls: () => calls,
  };
}

async function events(client: AgenticClient, input: RunRequest) {
  const received: RunEvent[] = [];
  for await (const event of client.stream(input)) received.push(event);
  assert.equal(received[0]?.type, "run.started");
  assert.deepEqual(
    received.map((event) => event.sequence),
    received.map((_, index) => index + 1),
  );
  assert.equal(new Set(received.map((event) => event.runId)).size, 1);
  return received;
}

function typedError(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof DriverError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
    return true;
  };
}

for (const example of [
  {
    name: "2020-12 composition, tuple and local refs",
    schema: proposalSchema,
    output: proposal,
  },
  {
    name: "implicit draft-07 fallback",
    schema: legacySchema,
    output: { evidence: ["selected-paper@r1", 2] },
  },
  {
    name: "explicit draft-07",
    schema: { $schema: draft07, ...legacySchema },
    output: { evidence: ["selected-paper@r1", 2] },
  },
]) {
  test(`${transport}: run and stream preserve validated ${example.name}`, async () => {
    const fixture = await host(JSON.stringify(example.output));
    try {
      const input = { ...request, outputSchema: example.schema };
      const result = await fixture.client.run(input);
      assert.deepEqual(result.output, example.output);
      assert.equal(result.text, JSON.stringify(example.output));
      const received = await events(fixture.client, input);
      const last = received.at(-1);
      assert.equal(last?.type, "run.completed");
      if (last?.type !== "run.completed")
        assert.fail("Missing completed result");
      assert.deepEqual(last.result.output, example.output);
      assert.equal(last.result.runId, last.runId);
      assert.equal(
        received.filter((event) => event.type === "run.completed").length,
        1,
      );
      assert.equal(
        received.some((event) => event.type === "run.failed"),
        false,
      );
      assert.equal(fixture.calls(), 2);
    } finally {
      await fixture.close();
    }
  });
}

for (const example of [
  {
    name: "local source reference mismatch",
    text: JSON.stringify({
      ...proposal,
      evidence: ["unselected-paper@r1", 0.75],
    }),
  },
  {
    name: "prefixItems position type",
    text: JSON.stringify({
      ...proposal,
      evidence: ["selected-paper@r1", "certain"],
    }),
  },
  {
    name: "prefixItems numeric constraint",
    text: JSON.stringify({ ...proposal, evidence: ["selected-paper@r1", 1.1] }),
  },
  {
    name: "extra tuple item",
    text: JSON.stringify({
      ...proposal,
      evidence: [...proposal.evidence, "extra"],
    }),
  },
  {
    name: "missing tuple item",
    text: JSON.stringify({ ...proposal, evidence: ["selected-paper@r1"] }),
  },
  {
    name: "unevaluated property",
    text: JSON.stringify({ ...proposal, accepted: true }),
  },
  {
    name: "missing required claim",
    text: JSON.stringify({ evidence: proposal.evidence }),
  },
  { name: "malformed JSON", text: "A claim that is not JSON" },
  {
    name: "draft-07 tuple constraint",
    text: JSON.stringify({ evidence: ["selected-paper@r1", "not-an-integer"] }),
    schema: legacySchema,
  },
]) {
  test(`${transport}: ${example.name} yields INVALID_OUTPUT and one failed terminal event`, async () => {
    const fixture = await host(example.text);
    try {
      const input = {
        ...request,
        outputSchema: example.schema ?? proposalSchema,
      };
      await assert.rejects(
        fixture.client.run(input),
        typedError("INVALID_OUTPUT"),
      );
      const received = await events(fixture.client, input);
      const terminals = received.filter((event) =>
        ["run.completed", "run.failed", "run.cancelled"].includes(event.type),
      );
      assert.equal(terminals.length, 1);
      const terminal = terminals[0];
      assert.equal(terminal, received.at(-1));
      assert.equal(terminal?.type, "run.failed");
      if (terminal?.type !== "run.failed")
        assert.fail("Expected failed terminal event");
      assert.equal(terminal.error.code, "INVALID_OUTPUT");
      assert.equal(terminal.error.retryable, false);
      assert.equal(
        received.some((event) => event.type === "run.completed"),
        false,
      );
      assert.equal(fixture.calls(), 2);
    } finally {
      await fixture.close();
    }
  });
}

for (const example of [
  {
    name: "unsupported dialect",
    schema: {
      $schema: "https://json-schema.org/draft/2019-09/schema",
      type: "string",
    },
  },
  ...[draft07, draft2020].flatMap((dialect) => [
    {
      name: `${dialect} async validation`,
      schema: { $schema: dialect, $async: true, type: "string" },
    },
    {
      name: `${dialect} external reference`,
      schema: {
        $schema: dialect,
        $ref: "https://schema-fixture.invalid/external.json",
      },
    },
  ]),
]) {
  test(`${transport}: ${example.name} fails preflight without provider execution`, async () => {
    const fixture = await host('"unused"');
    try {
      const input = { ...request, outputSchema: example.schema };
      await assert.rejects(
        fixture.client.run(input),
        typedError("INVALID_SCHEMA"),
      );
      const received: RunEvent[] = [];
      await assert.rejects(async () => {
        for await (const event of fixture.client.stream(input))
          received.push(event);
      }, typedError("INVALID_SCHEMA"));
      assert.deepEqual(
        received,
        [],
        "Preflight rejection must precede run.started",
      );
      assert.equal(fixture.calls(), 0);
    } finally {
      await fixture.close();
    }
  });
}

if (!tlsDirectory) {
  test("structured-output transport suite also passes with certificate-verified HTTPS", async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "agenticdriver-schema-tls-"),
    );
    try {
      await command(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(directory, "key.pem"),
          "-out",
          join(directory, "cert.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-addext",
          "basicConstraints=critical,CA:FALSE",
          "-addext",
          "extendedKeyUsage=serverAuth",
        ],
        { timeout: 30_000 },
      );

      // Confirm that the normal Fetch transport rejects this fixture before the
      // child explicitly trusts its certificate. Never disable TLS verification.
      let calls = 0;
      const server = await serve(
        new AgenticDriver({
          providers: [
            mockProvider(() => {
              calls++;
              return { text: "unused" };
            }),
          ],
        }),
        {
          port: 0,
          tokens: [{ token, subject: "schema-user", providers: ["mock"] }],
          tls: await tlsFiles(directory),
        },
      );
      try {
        await assert.rejects(
          new AgenticClient({ url: server.url, token }).run(request),
          (error: unknown) => {
            assert.ok(error instanceof TypeError);
            assert.equal(
              (error.cause as NodeJS.ErrnoException)?.code,
              "DEPTH_ZERO_SELF_SIGNED_CERT",
            );
            return true;
          },
        );
        assert.equal(calls, 0);
      } finally {
        await server.close();
      }

      // NODE_EXTRA_CA_CERTS is read at process startup. A fresh process also
      // avoids modifying the global trust store of other concurrently run tests.
      const result = await command(
        process.execPath,
        [
          "--import",
          "tsx",
          "--test",
          "--test-reporter=tap",
          fileURLToPath(import.meta.url),
        ],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TMPDIR: directory,
            NODE_EXTRA_CA_CERTS: join(directory, "cert.pem"),
            AGENTICDRIVER_SCHEMA_TLS_FIXTURE: directory,
          },
          timeout: 60_000,
          maxBuffer: 2_000_000,
        },
      );
      assert.match(result.stdout, /# fail 0\b/);
      assert.match(result.stdout, /HTTPS: run and stream/);
      t.diagnostic(result.stdout);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

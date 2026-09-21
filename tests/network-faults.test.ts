import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request as forward } from "node:http";
import { request as httpsRequest } from "node:https";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AgenticDriver } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import { serve } from "../src/server.js";
import { mockProvider } from "../src/providers/mock.js";
import { Diagnostics } from "../src/diagnostics.js";
import type { ProviderContext } from "../src/types.js";

const token = "network-fixture-token-at-least-32-characters";
const input = {
  provider: "mock",
  model: "demo",
  input: "synthetic network check",
};
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function runningHost() {
  const started = deferred<ProviderContext>(),
    stopped = deferred();
  let calls = 0;
  const host = await serve(
    new AgenticDriver({
      providers: [
        mockProvider(async (_request, context) => {
          calls++;
          started.resolve(context);
          context.emitText("initial visible output");
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => {
                stopped.resolve();
                reject(context.signal.reason);
              },
              { once: true },
            );
          });
          return { text: "unreachable" };
        }),
      ],
    }),
    { port: 0, tokens: [{ token, subject: "synthetic", providers: ["mock"] }] },
  );
  return {
    host,
    started: started.promise,
    stopped: stopped.promise,
    calls: () => calls,
  };
}
async function proxy(target: string, mode: "stream" | "buffer" | "truncate") {
  const data = deferred(),
    pressure = deferred();
  let bufferingHeader: string | string[] | undefined;
  const server = createServer((req, res) => {
    const upstream = forward(new URL(req.url!, target), {
      method: req.method,
      headers: { ...req.headers, host: new URL(target).host },
    });
    upstream.on("error", () => res.destroy());
    res.once("close", () => upstream.destroy());
    req.once("aborted", () => upstream.destroy());
    req.pipe(upstream);
    upstream.once("response", (response) => {
      bufferingHeader = response.headers["x-accel-buffering"];
      res.writeHead(response.statusCode!, response.headers);
      const buffered: Buffer[] = [];
      let bytes = 0;
      response.on("error", () => res.destroy());
      response.on("data", (chunk: Buffer) => {
        data.resolve();
        if (mode === "buffer" || mode === "truncate") {
          bytes += chunk.length;
          assert.ok(
            bytes < 2_000_000,
            "Bound the fault fixture's own buffering",
          );
          buffered.push(chunk);
          if (
            mode === "truncate" &&
            Buffer.concat(buffered).includes('"type":"text.delta"')
          ) {
            // Match across arbitrary TCP chunks, then finish HTTP without the terminal event.
            res.end(": truncated upstream\n\n");
            upstream.destroy();
          }
        } else if (!res.write(chunk)) {
          pressure.resolve();
          response.pause();
          res.once("drain", () => response.resume());
        }
      });
      response.once("end", () => {
        if (!res.writableEnded)
          res.end(mode === "buffer" ? Buffer.concat(buffered) : undefined);
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    data: data.promise,
    pressure: pressure.promise,
    bufferingHeader: () => bufferingHeader,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

test(
  "a buffering proxy preserves explicit cancellation without retrying a silent connection",
  { timeout: 10000 },
  async () => {
    const running = await runningHost(),
      middle = await proxy(running.host.url, "buffer");
    const controller = new AbortController();
    try {
      const rejected = assert.rejects(
        new AgenticClient({ url: middle.url, token }).run(input, {
          signal: controller.signal,
        }),
        { name: "AbortError" },
      );
      await running.started;
      await middle.data;
      assert.equal(middle.bufferingHeader(), "no");
      controller.abort();
      await rejected;
      await running.stopped;
      assert.equal(running.calls(), 1);
    } finally {
      controller.abort();
      await middle.close();
      await running.host.close();
    }
  },
);

test(
  "a paused consumer can cancel through proxy backpressure while a provider is active",
  { timeout: 10000 },
  async () => {
    const running = await runningHost(),
      middle = await proxy(running.host.url, "stream");
    const controller = new AbortController();
    const stream = new AgenticClient({ url: middle.url, token }).stream(input, {
      signal: controller.signal,
    });
    try {
      for (;;) {
        const event = await stream.next();
        assert.equal(event.done, false);
        if (event.value!.type === "text.delta") break;
      }
      const context = await running.started;
      // Leave the application iterator paused while the proxy fills its writable buffer.
      context.emitText("x".repeat(256_000));
      await middle.pressure;
      controller.abort();
      await running.stopped;
      await assert.rejects(stream.next(), { name: "AbortError" });
      assert.equal(running.calls(), 1);
    } finally {
      controller.abort();
      await stream.return(undefined);
      await middle.close();
      await running.host.close();
    }
  },
);

test(
  "a proxy's clean HTTP EOF without a terminal SDK event is never accepted as completion",
  { timeout: 10000 },
  async () => {
    const running = await runningHost(),
      middle = await proxy(running.host.url, "truncate");
    try {
      await assert.rejects(
        new AgenticClient({ url: middle.url, token }).run(input),
        { code: "INCOMPLETE_STREAM" },
      );
      await running.stopped;
      assert.equal(running.calls(), 1);
    } finally {
      await middle.close();
      await running.host.close();
    }
  },
);

test(
  "untrusted certificates and hostname mismatches fail before an authenticated request is sent",
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenticdriver-tls-fault-"));
    let host: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      const key = join(directory, "key.pem"),
        cert = join(directory, "cert.pem");
      await promisify(execFile)("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
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
      ]);
      const ca = await readFile(cert),
        diagnostics = new Diagnostics();
      let calls = 0;
      host = await serve(
        new AgenticDriver({
          diagnostics,
          providers: [
            mockProvider(() => {
              calls++;
              return { text: "must not generate" };
            }),
          ],
        }),
        {
          port: 0,
          tls: { key: await readFile(key), cert: await readFile(cert) },
          tokens: [{ token, subject: "synthetic", providers: ["mock"] }],
        },
      );
      await assert.rejects(
        new AgenticClient({ url: host.url, token }).run(input),
        (error) =>
          error instanceof Error &&
          [
            "DEPTH_ZERO_SELF_SIGNED_CERT",
            "SELF_SIGNED_CERT_IN_CHAIN",
            "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
          ].includes(
            (error.cause as { code?: string } | undefined)?.code ?? "",
          ),
      );
      const endpoint = new URL("/v1/runs", host.url);
      await assert.rejects(
        new Promise<void>((resolveRequest, reject) => {
          const request = httpsRequest(
            endpoint,
            {
              ca,
              servername: "wrong-hostname.example",
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
            },
            (response) => {
              response.resume();
              resolveRequest();
            },
          );
          request.once("error", reject);
          request.end(JSON.stringify(input));
        }),
        { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
      );
      assert.equal(calls, 0);
      assert.ok(
        Object.values(diagnostics.metrics().host).every((count) => count === 0),
      );
      await diagnostics.close();
    } finally {
      await host?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

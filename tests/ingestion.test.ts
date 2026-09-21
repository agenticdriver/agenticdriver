import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { AgenticDriver } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import { serve } from "../src/server.js";
import {
  RetrievalService,
  MemoryVectorStore,
  DeterministicEmbeddingAdapter,
} from "../src/retrieval.js";
import {
  PopplerPdfExtractor,
  type PdfExtractor,
  type IngestRequest,
} from "../src/ingestion.js";
import { mockProvider } from "../src/providers/index.js";
import { DriverError } from "../src/errors.js";

function fixturePdf(texts: string[]): string {
  const pages = texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages}] /Count ${texts.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const text of texts) {
    const content = text
      ? `BT /F1 18 Tf 40 700 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`
      : "";
    const pageId = objects.length + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString("base64");
}
const source = { id: "paper", revision: "r1", uri: "app://library/paper" };
const markdown = (text: string): IngestRequest => ({
  corpus: "library",
  document: { type: "text", mediaType: "text/markdown", source, text },
});
const pdf = (texts: string[]): IngestRequest => ({
  corpus: "library",
  document: {
    type: "pdf",
    source,
    data: fixturePdf(texts),
    mediaType: "application/pdf",
  },
});
function host(
  ingestion: ConstructorParameters<typeof AgenticDriver>[0]["ingestion"] = {},
) {
  let revision = "r1",
    allowed = true;
  const store = new MemoryVectorStore(),
    retrieval = new RetrievalService([
      {
        id: "library",
        version: "v1",
        store,
        embedding: new DeterministicEmbeddingAdapter(64),
        authorize: (_, ctx) =>
          allowed && ctx.subject === "alice"
            ? { namespace: "workspace", sources: { paper: revision } }
            : null,
      },
    ]);
  const driver = new AgenticDriver({
    retrieval,
    ingestion,
    providers: [mockProvider()],
  });
  return {
    driver,
    store,
    retrieval,
    revoke() {
      allowed = false;
    },
    revision(value: string) {
      revision = value;
    },
  };
}
const options = { subject: "alice" },
  search = {
    corpus: "library",
    sourceIds: ["paper"],
    query: "evidence",
    limit: 16,
  };

test("Markdown sections, fenced headings, line ranges and UTF-8 chunks survive ingestion and retrieval", async () => {
  const { driver } = host({ maxChunkBytes: 128 });
  const text =
    "# First\nEvidence one.\n```md\n# This is code\n```\n\nSecond\n------\nEvidence two. " +
    "🌍".repeat(90);
  const indexed = await driver.ingestContext(markdown(text), options);
  assert.equal(indexed.ingestion.format, "markdown");
  assert.equal(
    indexed.ingestion.inputSha256,
    createHash("sha256").update(text).digest("hex"),
  );
  assert.equal(indexed.ingestion.indexedTextBytes, Buffer.byteLength(text));
  const found = await driver.searchContext(search, options);
  assert.ok(found.hits.length >= 4);
  assert.deepEqual(
    new Set(found.hits.map((hit) => hit.source.location?.section)),
    new Set(["First", "Second"]),
  );
  const first = found.hits.find(
    (hit) => hit.source.location?.section === "First",
  )!;
  assert.equal(first.source.location!.startLine, 1);
  assert.equal(first.source.location!.endLine, 6);
  assert.match(first.text, /# This is code/);
  for (const hit of found.hits) {
    assert.ok(Buffer.byteLength(hit.text) <= 128);
    assert.ok(!hit.text.includes("�"));
    assert.equal(hit.ingestion!.inputSha256, indexed.ingestion.inputSha256);
    assert.match(hit.chunkId, /^p-[0-9a-f]{64}$/);
  }
  assert.equal(
    (await driver.ingestContext(markdown(text), options)).status,
    "unchanged",
  );
});

test("original byte changes under an immutable revision conflict even when normalized text is identical", async () => {
  const { driver } = host();
  await driver.ingestContext(markdown("# Evidence\nOne finding.\n"), options);
  await assert.rejects(
    driver.ingestContext(markdown("# Evidence\r\nOne finding.\r\n"), options),
    { code: "SOURCE_CONFLICT" },
  );
});

test("email thread chunks preserve message boundaries and disclose empty messages", async () => {
  const { driver } = host({ maxChunkBytes: 128 });
  const result = await driver.ingestContext(
    {
      corpus: "library",
      document: {
        type: "email",
        source,
        threadId: "thread-one",
        messages: [
          { id: "message-one", text: "Evidence from the first message." },
          { id: "empty-message", text: "  \n" },
          { id: "message-two", text: "Evidence from the second message." },
        ],
      },
    },
    options,
  );
  assert.deepEqual(result.ingestion.messages, { total: 3, empty: 1 });
  const evidence = await driver.searchContext(search, options);
  assert.deepEqual(
    new Set(evidence.hits.map((hit) => hit.source.location!.messageId)),
    new Set(["message-one", "message-two"]),
  );
  assert.ok(
    evidence.hits.every(
      (hit) =>
        hit.source.location!.threadId === "thread-one" &&
        hit.source.location!.startLine === 1,
    ),
  );
});

const nativePdf =
  spawnSync("pdftotext", ["-v"], { stdio: "ignore" }).status === 0 &&
  spawnSync("pdfinfo", ["-v"], { stdio: "ignore" }).status === 0;
test(
  "real Poppler extracts digital PDF pages with bounded, traceable provenance",
  { skip: !nativePdf },
  async () => {
    const { driver } = host({ pdf: new PopplerPdfExtractor() });
    const result = await driver.ingestContext(
      pdf(["Evidence from page one", "Evidence from page two"]),
      options,
    );
    assert.deepEqual(result.ingestion.pages, { total: 2, ocr: [], empty: [] });
    assert.equal(result.ingestion.extractor.id, "poppler-layout");
    assert.match(result.ingestion.extractor.version, /^[0-9]/);
    const evidence = await driver.searchContext(search, options);
    assert.deepEqual(
      new Set(evidence.hits.map((hit) => hit.source.location!.page)),
      new Set([1, 2]),
    );
    assert.ok(
      evidence.hits.some((hit) => hit.text.includes("Evidence from page two")),
    );
    await assert.rejects(
      driver.ingestContext(
        {
          ...pdf(["irrelevant"]),
          document: {
            type: "pdf",
            source,
            mediaType: "application/pdf",
            data: Buffer.from("%PDF-broken\n%%EOF").toString("base64"),
          },
        },
        options,
      ),
      { code: "INVALID_DOCUMENT" },
    );
  },
);

test("empty PDF pages require explicit OCR or an explicit omission policy", async () => {
  const extractor: PdfExtractor = {
    async extract() {
      return {
        pages: [
          { page: 1, text: "Evidence one" },
          { page: 2, text: "" },
        ],
        extractor: { id: "fixture-pdf", version: "1" },
      };
    },
  };
  await assert.rejects(host().driver.ingestContext(pdf(["page"]), options), {
    code: "PDF_EXTRACTOR_REQUIRED",
  });
  await assert.rejects(
    host({ pdf: extractor }).driver.ingestContext(pdf(["page"]), options),
    { code: "OCR_REQUIRED" },
  );
  let selected: readonly number[] = [];
  const { driver } = host({
    pdf: extractor,
    ocr: {
      async extract(_pdf, pages) {
        selected = pages;
        return {
          pages: [{ page: 2, text: "Explicitly recognized evidence" }],
          extractor: { id: "fixture-ocr", version: "1" },
        };
      },
    },
  });
  const result = await driver.ingestContext(pdf(["page"]), options);
  assert.deepEqual(selected, [2]);
  assert.deepEqual(result.ingestion.pages, { total: 2, ocr: [2], empty: [] });
  assert.equal(result.ingestion.ocrExtractor!.id, "fixture-ocr");
  const omitted = await host({
    pdf: extractor,
    allowEmptyPdfPages: true,
  }).driver.ingestContext(pdf(["page"]), options);
  assert.deepEqual(omitted.ingestion.pages, { total: 2, ocr: [], empty: [2] });
});

test("authorization precedes parsing and failed replacement retains the old index", async () => {
  let parsed = 0;
  const state = host({
    pdf: {
      async extract() {
        parsed++;
        throw new DriverError("INVALID_DOCUMENT", "Fixture parse failure");
      },
    },
  });
  await state.driver.ingestContext(markdown("Original evidence"), options);
  state.revision("r2");
  const changed = pdf(["page"]);
  if (changed.document.type !== "pdf") throw new Error("fixture");
  changed.document.source = { ...source, revision: "r2" };
  await assert.rejects(state.driver.ingestContext(changed, options), {
    code: "INVALID_DOCUMENT",
  });
  assert.equal(parsed, 1);
  state.revision("r1");
  assert.match(
    (await state.driver.searchContext(search, options)).hits[0]!.text,
    /Original evidence/,
  );
  state.revoke();
  await assert.rejects(state.driver.ingestContext(pdf(["page"]), options), {
    code: "CONTEXT_NOT_FOUND",
  });
  assert.equal(parsed, 1);
});

test("document and chunk limits, empty extraction and cancellation never write a partial index", async () => {
  const limited = host({ maxChunks: 1, maxChunkBytes: 128 });
  await assert.rejects(
    limited.driver.ingestContext(markdown("x".repeat(300)), options),
    { code: "DOCUMENT_LIMIT" },
  );
  assert.deepEqual(
    (await limited.driver.searchContext(search, options)).hits,
    [],
  );
  await assert.rejects(
    limited.driver.ingestContext(markdown("   \n"), options),
    { code: "EMPTY_DOCUMENT" },
  );
  await assert.rejects(
    limited.driver.ingestContext(markdown("invalid\0text"), options),
    { code: "INVALID_DOCUMENT" },
  );
  const stalled = host({ pdf: { extract: () => new Promise(() => {}) } });
  await assert.rejects(
    stalled.driver.ingestContext(
      { ...pdf(["page"]), idleTimeoutMs: 20 },
      options,
    ),
    { code: "IDLE_TIMEOUT" },
  );
  assert.deepEqual(
    (await stalled.driver.searchContext(search, options)).hits,
    [],
  );
});

test("authenticated HTTP ingestion uses the index grant and retains provenance in remote retrieval", async () => {
  const { driver } = host();
  const token = "a".repeat(40),
    denied = "d".repeat(40);
  const server = await serve(driver, {
    port: 0,
    tokens: [
      {
        token,
        subject: "alice",
        providers: ["mock"],
        retrieval: { index: ["library"], search: ["library"] },
      },
      {
        token: denied,
        subject: "alice",
        providers: ["mock"],
        retrieval: { search: ["library"] },
      },
    ],
  });
  try {
    const client = new AgenticClient({ url: server.url, token });
    assert.ok(
      (await client.protocol()).features.includes("document-ingestion"),
    );
    assert.ok(!(await client.protocol()).features.includes("pdf-ingestion"));
    await assert.rejects(
      new AgenticClient({ url: server.url, token: denied }).ingestContext(
        markdown("Evidence"),
      ),
      { code: "FORBIDDEN" },
    );
    const receipt = await client.ingestContext(
      markdown("# Evidence\nOne finding."),
    );
    assert.equal(receipt.ingestion.format, "markdown");
    const result = await client.run({
      provider: "mock",
      model: "demo",
      input: "evidence",
      retrieval: search,
    });
    assert.equal(
      result.retrieval!.hits[0]!.ingestion!.inputSha256,
      receipt.ingestion.inputSha256,
    );
  } finally {
    await server.close();
  }
});

test("references release their leases after parsing and reauthorization denies revoked or changed sources", async () => {
  let allowed = true,
    revision = "r1",
    resolved = 0,
    released = 0;
  const retrieval = new RetrievalService([
    {
      id: "library",
      version: "v1",
      store: new MemoryVectorStore(),
      embedding: new DeterministicEmbeddingAdapter(32),
      authorize: () =>
        allowed
          ? { namespace: "workspace", sources: { paper: revision } }
          : null,
    },
  ]);
  let behavior: "ok" | "revoke" | "change" | "malformed" = "ok";
  const driver = new AgenticDriver({
    providers: [mockProvider()],
    retrieval,
    context: {
      resolve: () => {
        resolved++;
        return {
          attachment: pdf(["Evidence"]).document as {
            type: "pdf";
            source: typeof source;
            data: string;
            mediaType: "application/pdf";
          },
          release: () => {
            released++;
          },
        };
      },
    },
    ingestion: {
      pdf: {
        extract: async () => {
          if (behavior === "revoke") allowed = false;
          if (behavior === "change") revision = "r2";
          return {
            extractor: { id: "fixture", version: "1" },
            pages: [
              { page: behavior === "malformed" ? 2 : 1, text: "Evidence" },
            ],
          };
        },
      },
    },
  });
  const request: IngestRequest = {
    corpus: "library",
    document: {
      type: "reference",
      id: "paper",
      revision: "r1",
      mediaType: "application/pdf",
    },
  };
  await driver.ingestContext(request, options);
  const original = await driver.searchContext(search, options);
  for (const next of ["revoke", "change", "malformed"] as const) {
    behavior = next;
    await assert.rejects(driver.ingestContext(request, options), {
      code: next === "malformed" ? "INVALID_EXTRACTION" : "CONTEXT_NOT_FOUND",
    });
    assert.equal(resolved, released);
    allowed = true;
    revision = "r1";
    assert.deepEqual(await driver.searchContext(search, options), original);
  }
  allowed = false;
  await assert.rejects(driver.ingestContext(request, options), {
    code: "CONTEXT_NOT_FOUND",
  });
  assert.equal(
    resolved,
    4,
    "revocation must reject before resolving a reference",
  );
});

test("malformed extractor results and invalid request shapes fail before embedding", async () => {
  for (const result of [
    { pages: [null], extractor: { id: "fixture", version: "1" } },
    {
      pages: [{ page: 1, text: "Evidence" }],
      extractor: { id: "bad/id", version: "1" },
    },
    {
      pages: [
        { page: 1, text: "Evidence" },
        { page: 1, text: "Duplicate" },
      ],
      extractor: { id: "fixture", version: "1" },
    },
  ]) {
    const { driver } = host({
      pdf: {
        extract: async () =>
          result as Awaited<ReturnType<PdfExtractor["extract"]>>,
      },
    });
    await assert.rejects(driver.ingestContext(pdf(["Evidence"]), options), {
      code: "INVALID_EXTRACTION",
    });
  }
  const { driver } = host();
  await assert.rejects(driver.ingestContext(null as unknown as IngestRequest), {
    code: "INVALID_INGESTION",
  });
  await assert.rejects(
    driver.ingestContext(
      { ...markdown("Evidence"), idleTimeoutMs: -1 },
      options,
    ),
    { code: "INVALID_INGESTION" },
  );
});

test(
  "real PDF extraction rejects page and output limits without truncation",
  { skip: !nativePdf },
  async () => {
    const pages = host({ pdf: new PopplerPdfExtractor(), maxPages: 1 });
    await assert.rejects(
      pages.driver.ingestContext(pdf(["Evidence", "Second page"]), options),
      { code: "DOCUMENT_LIMIT" },
    );
    const text = host({ pdf: new PopplerPdfExtractor(), maxTextBytes: 4 });
    await assert.rejects(
      text.driver.ingestContext(pdf(["Longer evidence"]), options),
      { code: "DOCUMENT_LIMIT" },
    );
    const blank = host({ pdf: new PopplerPdfExtractor() });
    await assert.rejects(blank.driver.ingestContext(pdf([""]), options), {
      code: "OCR_REQUIRED",
    });
  },
);

test("ingestion has no default deadline and real extractor progress resets only an explicit inactivity policy", async () => {
  let report = true;
  const extractor: PdfExtractor = {
    extract: async (_bytes, _limits, ctx) => {
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 8));
        ctx.signal.throwIfAborted();
        if (report) ctx.reportProgress();
      }
      return {
        pages: [{ page: 1, text: "Evidence" }],
        extractor: { id: "slow-fixture", version: "1" },
      };
    },
  };
  const { driver } = host({ pdf: extractor });
  report = false;
  assert.equal(
    (await driver.ingestContext(pdf(["Evidence"]), options)).status,
    "indexed",
  );
  report = true;
  assert.equal(
    (
      await driver.ingestContext(
        { ...pdf(["Evidence"]), idleTimeoutMs: 40 },
        options,
      )
    ).status,
    "unchanged",
  );
  report = false;
  await assert.rejects(
    driver.ingestContext({ ...pdf(["Evidence"]), idleTimeoutMs: 20 }, options),
    { code: "IDLE_TIMEOUT" },
  );
});

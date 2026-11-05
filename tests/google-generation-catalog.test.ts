import assert from "node:assert/strict";
import test from "node:test";
import { parseGoogleGenerationCatalogPage } from "../src/providers/discovery.js";

test("Google generation catalog selects the declared operation, not model names", () => {
  const page = parseGoogleGenerationCatalogPage({
    models: [
      {
        name: "models/content",
        supportedGenerationMethods: ["countTokens", "generateContent"],
      },
      {
        name: "models/gemini-embedding",
        supportedGenerationMethods: ["embedContent"],
      },
      {
        name: "models/gemini-predict",
        supportedGenerationMethods: ["predict", "predictLongRunning"],
      },
      {
        name: "models/gemini-count",
        supportedGenerationMethods: ["countTokens"],
      },
      { name: "models/gemini-unknown" },
      { name: "models/gemini-empty", supportedGenerationMethods: [] },
      {
        name: "models/gemini-stream-only",
        supportedGenerationMethods: ["streamGenerateContent"],
      },
      {
        name: "models/gemini-case",
        supportedGenerationMethods: ["GenerateContent"],
      },
    ],
    nextPageToken: "second-page",
  });
  assert.deepEqual(page, { models: ["content"], nextPageToken: "second-page" });
});

test("an empty eligible page retains its continuation token", () => {
  assert.deepEqual(
    parseGoogleGenerationCatalogPage({
      models: [
        {
          name: "models/embedding",
          supportedGenerationMethods: ["embedContent"],
        },
      ],
      nextPageToken: "more-models",
    }),
    { models: [], nextPageToken: "more-models" },
  );
  assert.deepEqual(parseGoogleGenerationCatalogPage({}), {
    models: [],
    nextPageToken: undefined,
  });
});

test("Google catalog validates all metadata before selecting generation models", () => {
  for (const raw of [
    {
      models: [
        {
          name: "models/embedding",
          supportedGenerationMethods: "embedContent",
        },
      ],
    },
    {
      models: [
        { name: "invalid model", supportedGenerationMethods: ["embedContent"] },
      ],
    },
    {
      models: Array.from({ length: 1001 }, () => ({
        name: "models/content",
        supportedGenerationMethods: ["generateContent"],
      })),
    },
    { nextPageToken: "x".repeat(4097) },
  ])
    assert.throws(() => parseGoogleGenerationCatalogPage(raw));
});

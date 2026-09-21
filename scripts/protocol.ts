import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { format } from "prettier";
import { HostConfigSchema } from "../src/host.js";
import {
  ContextManifestSchema,
  DraftArtifactSchema,
  ContextMediaTypeSchema,
} from "../src/context-types.js";
import { UsageRecordSchema } from "../src/usage.js";
import {
  IngestRequestSchema,
  IngestResultSchema,
  IngestionManifestSchema,
} from "../src/ingestion-types.js";
import {
  RetrievalSearchSchema,
  RetrievalIndexRequestSchema,
  RetrievalDeleteSchema,
  RetrievalResultSchema,
  RetrievalIndexResultSchema,
  RetrievalDeleteResultSchema,
} from "../src/retrieval-types.js";
import {
  RunRequestSchema,
  ModelCatalogSchema,
  ProviderHealthSchema,
} from "../src/types.js";
import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  OPTIONAL_EVENTS_HEADER,
  RUN_EVENT_TYPES,
} from "../src/protocol.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: "string" },
  count = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const request = z.toJSONSchema(RunRequestSchema, { target: "draft-2020-12" });
const { $schema: _schema, ...requestSchema } = request;
const schemas = {
  IngestRequest: z.toJSONSchema(IngestRequestSchema, {
    target: "draft-2020-12",
  }),
  IngestResult: z.toJSONSchema(IngestResultSchema, { target: "draft-2020-12" }),
  IngestionManifest: z.toJSONSchema(IngestionManifestSchema, {
    target: "draft-2020-12",
  }),
  RetrievalSearch: z.toJSONSchema(RetrievalSearchSchema, {
    target: "draft-2020-12",
  }),
  RetrievalIndexRequest: z.toJSONSchema(RetrievalIndexRequestSchema, {
    target: "draft-2020-12",
  }),
  RetrievalDelete: z.toJSONSchema(RetrievalDeleteSchema, {
    target: "draft-2020-12",
  }),
  RetrievalResult: z.toJSONSchema(RetrievalResultSchema, {
    target: "draft-2020-12",
  }),
  RetrievalIndexResult: z.toJSONSchema(RetrievalIndexResultSchema, {
    target: "draft-2020-12",
  }),
  RetrievalDeleteResult: z.toJSONSchema(RetrievalDeleteResultSchema, {
    target: "draft-2020-12",
  }),
  ProviderHealth: z.toJSONSchema(ProviderHealthSchema, {
    target: "draft-2020-12",
    io: "input",
  }),
  ModelCatalog: z.toJSONSchema(ModelCatalogSchema, {
    target: "draft-2020-12",
    io: "input",
  }),
  RunRequest: requestSchema,
  ContextManifest: z.toJSONSchema(ContextManifestSchema, {
    target: "draft-2020-12",
  }),
  DraftArtifact: z.toJSONSchema(DraftArtifactSchema, {
    target: "draft-2020-12",
  }),
  ProtocolInfo: {
    type: "object",
    required: ["protocol", "version", "supportedVersions", "features"],
    properties: {
      protocol: { const: "agenticdriver" },
      version: string,
      supportedVersions: { type: "array", items: string },
      features: { type: "array", items: string },
    },
  },
  Usage: {
    type: "object",
    properties: {
      inputTokens: count,
      outputTokens: count,
      cachedInputTokens: count,
      reasoningTokens: count,
      costUsd: { type: "number", minimum: 0 },
      apiEquivalentCostUsd: {
        type: "number",
        minimum: 0,
        description:
          "Reported API-equivalent estimate; never subscription spend or an invoice charge.",
      },
    },
    description:
      "Measurements are omitted when unknown. Cached input is a subset of input tokens. Totals are omitted if any model step lacks that measurement.",
  },
  RunResult: {
    type: "object",
    required: [
      "runId",
      "provider",
      "model",
      "text",
      "usage",
      "steps",
      "finishReason",
    ],
    properties: {
      runId: string,
      provider: string,
      model: string,
      text: string,
      output: {},
      sources: { type: "array", maxItems: 16, items: ref("ContextManifest") },
      artifacts: { type: "array", maxItems: 1, items: ref("DraftArtifact") },
      retrieval: ref("RetrievalResult"),
      usage: ref("Usage"),
      steps: { type: "integer", minimum: 1 },
      finishReason: { enum: ["stop", "length"] },
    },
  },
  Error: {
    type: "object",
    required: ["error"],
    properties: { error: ref("ErrorInfo") },
  },
  ErrorInfo: {
    type: "object",
    required: ["code", "message", "retryable"],
    properties: {
      code: { type: "string", minLength: 1 },
      message: string,
      retryable: { type: "boolean" },
      outcome: {
        const: "uncertain",
        description:
          "Effects may have occurred; reconcile them before any replacement operation.",
      },
    },
    description:
      "Stable code, displayable message and retryability hint. Clients preserve unknown codes; retryable never authorizes automatic replay of tool effects.",
  },
  Provider: {
    type: "object",
    required: ["id", "name", "vendor", "authMode", "capabilities"],
    properties: {
      id: string,
      name: string,
      vendor: string,
      authMode: { enum: ["api-key", "cli-session", "none"] },
      models: { type: "array", items: string },
      usageStatId: string,
      inputMediaTypes: {
        type: "object",
        additionalProperties: {
          type: "array",
          maxItems: 6,
          items: z.toJSONSchema(ContextMediaTypeSchema),
        },
      },
      health: ref("ProviderHealth"),
      modelCatalog: ref("ModelCatalog"),
      capabilities: {
        type: "object",
        required: ["tools", "textStreaming"],
        properties: {
          tools: { type: "boolean" },
          textStreaming: { type: "boolean" },
        },
        additionalProperties: { type: "boolean" },
      },
    },
  },
  RunEvent: {
    type: "object",
    required: ["type", "runId", "sequence", "timestamp"],
    properties: {
      type: string,
      runId: string,
      sequence: {
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      timestamp: { type: "string", format: "date-time" },
      optional: {
        type: "boolean",
        description:
          "An unknown type may be skipped only when optional is explicitly true; its envelope and sequence must still be validated.",
      },
    },
    oneOf: [
      {
        properties: {
          type: { const: "run.started" },
          provider: string,
          model: string,
        },
        required: ["provider", "model"],
      },
      {
        properties: {
          type: { const: "step.started" },
          step: { type: "integer", minimum: 1 },
        },
        required: ["step"],
      },
      {
        properties: { type: { const: "text.delta" }, text: string },
        required: ["text"],
      },
      {
        properties: {
          type: { const: "run.progress" },
          phase: { enum: ["model", "tool", "context"] },
        },
        required: ["phase"],
      },
      {
        properties: {
          type: { const: "tool.called" },
          call: {
            type: "object",
            required: ["id", "name", "arguments"],
            properties: {
              id: string,
              name: string,
              arguments: { type: "object" },
            },
          },
        },
        required: ["call"],
      },
      {
        properties: {
          type: { const: "tool.completed" },
          callId: string,
          output: {},
        },
        required: ["callId", "output"],
      },
      {
        properties: {
          type: { const: "usage.reported" },
          step: { type: "integer", minimum: 1 },
          usage: ref("Usage"),
        },
        required: ["step", "usage"],
      },
      {
        properties: {
          type: { const: "run.completed" },
          result: ref("RunResult"),
        },
        required: ["result"],
      },
      {
        properties: {
          type: { enum: ["run.failed", "run.cancelled"] },
          error: ref("ErrorInfo"),
        },
        required: ["error"],
      },
      {
        properties: {
          type: {
            type: "string",
            minLength: 1,
            not: { enum: RUN_EVENT_TYPES },
          },
          optional: { const: true },
        },
        required: ["optional"],
        description:
          "Advisory extension. Hosts send new event types only to clients that explicitly accept optional events. They cannot carry required state transitions or actions.",
      },
    ],
  },
};
const errorResponse = {
  description: "Authentication, validation, capacity, or execution failure",
  content: { "application/json": { schema: ref("Error") } },
  headers: {
    [PROTOCOL_VERSION_HEADER]: {
      schema: { const: PROTOCOL_VERSION },
      description: "The host's selected wire version.",
    },
  },
};
const parameters = [
  { $ref: "#/components/parameters/ProtocolVersion" },
  { $ref: "#/components/parameters/OptionalEvents" },
];
const document = {
  openapi: "3.1.0",
  info: { title: "AgenticDriver SDK protocol", version: "1.0.0" },
  servers: [
    { url: "https://driver.example.com" },
    { url: "http://127.0.0.1:7433", description: "Loopback development" },
  ],
  security: [{ bearerAuth: [] }],
  paths: {
    ...Object.fromEntries(
      [
        ["search", "RetrievalSearch", "RetrievalResult"],
        ["index", "RetrievalIndexRequest", "RetrievalIndexResult"],
        ["ingest", "IngestRequest", "IngestResult"],
        ["delete", "RetrievalDelete", "RetrievalDeleteResult"],
      ].map(([operation, input, output]) => [
        `/v1/retrieval/${operation}`,
        {
          post: {
            operationId: `${operation}Context`,
            parameters,
            description:
              "Requires an explicit token corpus/operation grant and application authorization. No automatic retries or execution deadline. Disconnect cancels pending work; reconcile an unacknowledged mutation before replacing it.",
            requestBody: {
              required: true,
              content: { "application/json": { schema: ref(input!) } },
            },
            responses: {
              "200": {
                description:
                  "Scoped retrieval result or source mutation receipt",
                content: { "application/json": { schema: ref(output!) } },
              },
              default: errorResponse,
            },
          },
        },
      ]),
    ),
    "/health": {
      get: {
        operationId: "health",
        security: [],
        responses: {
          "200": { description: "Host health and protocol version" },
        },
      },
    },
    "/v1/providers": {
      get: {
        operationId: "listProviders",
        parameters: [
          ...parameters,
          {
            name: "refresh",
            in: "query",
            schema: { const: "true" },
            description:
              "Refresh account health and model inventory, subject to the host's minimum refresh interval. Omit to use the normal cache.",
          },
        ],
        responses: {
          "200": {
            description: "Only provider instances allowed by this token",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["providers"],
                  properties: {
                    providers: { type: "array", items: ref("Provider") },
                  },
                },
              },
            },
          },
          default: errorResponse,
        },
      },
    },
    "/v1/protocol": {
      get: {
        operationId: "getProtocol",
        parameters,
        description:
          "Authenticated wire-version and host-feature discovery. An omitted version header selects the original 1.0 contract.",
        responses: {
          "200": {
            description: "Supported protocol versions and host features",
            content: { "application/json": { schema: ref("ProtocolInfo") } },
          },
          default: errorResponse,
        },
      },
    },
    "/v1/runs": {
      post: {
        operationId: "run",
        parameters,
        description:
          "Accept: application/json for one result; text/event-stream for ordered events. Disconnect cancels an unfinished run. No retries, reconnection, or resumable server state.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("RunRequest") } },
        },
        responses: {
          "200": {
            description:
              "Completed JSON result or an SSE stream with one terminal event",
            content: {
              "application/json": { schema: ref("RunResult") },
              "text/event-stream": {
                schema: { type: "string" },
                description:
                  "SSE data is a JSON RunEvent; id is its sequence; event is its type.",
              },
            },
          },
          default: errorResponse,
        },
      },
    },
  },
  components: {
    parameters: {
      ProtocolVersion: {
        name: PROTOCOL_VERSION_HEADER,
        in: "header",
        required: false,
        schema: { type: "string", default: PROTOCOL_VERSION },
        description:
          "Exact wire version to select. Unsupported values fail before provider/tool execution. Independent of package versions.",
      },
      OptionalEvents: {
        name: OPTIONAL_EVENTS_HEADER,
        in: "header",
        required: false,
        schema: { type: "string", enum: ["true", "false"], default: "false" },
        description:
          "Opt in to unknown advisory event types marked optional:true. Older clients omit this header and receive only the original event types.",
      },
    },
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas,
  },
};
for (const path of Object.values(document.paths)) {
  for (const operation of Object.values(path)) {
    Object.assign(operation.responses["200"], {
      headers: errorResponse.headers,
    });
  }
}
await mkdir(new URL("../protocol/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../protocol/openapi.json", import.meta.url),
  await format(JSON.stringify(document), { parser: "json" }),
);
await writeFile(
  new URL("../protocol/host-config.schema.json", import.meta.url),
  await format(
    JSON.stringify(
      z.toJSONSchema(HostConfigSchema, {
        target: "draft-2020-12",
        io: "input",
      }),
    ),
    { parser: "json" },
  ),
);
await writeFile(
  new URL("../protocol/usage-record.schema.json", import.meta.url),
  await format(
    JSON.stringify(
      z.toJSONSchema(UsageRecordSchema, { target: "draft-2020-12" }),
    ),
    { parser: "json" },
  ),
);

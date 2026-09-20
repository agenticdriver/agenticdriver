import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { format } from "prettier";
import { RunRequestSchema } from "../src/types.js";
import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  OPTIONAL_EVENTS_HEADER,
  RUN_EVENT_TYPES,
} from "../src/protocol.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: "string" },
  count = { type: "integer", minimum: 0 };
const request = z.toJSONSchema(RunRequestSchema, { target: "draft-2020-12" });
const { $schema: _schema, ...requestSchema } = request;
const schemas = {
  RunRequest: requestSchema,
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
      code: string,
      message: string,
      retryable: { type: "boolean" },
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
      sequence: { type: "integer", minimum: 1 },
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
          phase: { enum: ["model", "tool"] },
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
          step: count,
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
        parameters,
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

import "/panel.js";
const checkedAt = new Date().toISOString();
const providers = [
  {
    id: "codex-fixture",
    name: "Codex",
    vendor: "codex",
    authMode: "cli-session",
    capabilities: { tools: true, textStreaming: false },
    modelCatalog: {
      source: "provider",
      models: ["fixture-small", "fixture-large"],
      complete: true,
    },
    health: {
      status: "unknown",
      code: "CLI_CATALOG_AVAILABLE",
      message:
        "Saved sign-in and model catalogue reported. Model execution and quota have not been tested.",
      checkedAt,
    },
    connection: {
      source: "native-runtime",
      checkedAt,
      runtime: { name: "Codex CLI", version: "0.157.0" },
      account: {
        status: "signed-in",
        method: "ChatGPT",
        email: "alex@example.invalid",
        name: "Alex Example",
        subscription: "Pro",
      },
    },
  },
  {
    id: "claude-fixture",
    name: "Claude Code",
    vendor: "claude-code",
    authMode: "cli-session",
    capabilities: { tools: false, textStreaming: true },
    health: {
      status: "unknown",
      code: "CLI_SESSION_PRESENT",
      message:
        "The native runtime reports a saved sign-in. Model execution has not been tested.",
      checkedAt,
    },
    connection: {
      source: "native-runtime",
      checkedAt,
      runtime: { name: "Claude Code", version: "2.1.282" },
      account: {
        status: "signed-in",
        method: "claude.ai",
        email: "sam@example.invalid",
        subscription: "Pro",
      },
    },
  },
  {
    id: "gemini-fixture",
    name: "Gemini CLI",
    vendor: "gemini-cli",
    authMode: "cli-session",
    capabilities: { tools: false, textStreaming: true },
    health: {
      status: "unknown",
      code: "CLI_STATUS_UNKNOWN",
      message: "No supported non-generation account check is available.",
      checkedAt,
    },
    connection: {
      source: "native-runtime",
      checkedAt,
      runtime: { name: "Gemini CLI", version: "0.58.0" },
    },
  },
  {
    id: "api-fixture",
    name: "OpenAI API",
    vendor: "openai",
    authMode: "api-key",
    capabilities: { tools: true, textStreaming: true },
    health: {
      status: "ready",
      code: "CATALOG_AVAILABLE",
      message:
        "The catalogue is reachable. Model execution and quota have not been tested.",
      checkedAt,
    },
  },
];
const state = {
  connected: true,
  connection: {
    id: "provider-details-fixture",
    label: "Local workstation · fixture",
    url: "http://127.0.0.1",
  },
  providers,
  canDisconnect: true,
  canConnect: false,
  canInvite: false,
};
window.fixtureRequests = [];
window.fixtureViolations = [];
document.addEventListener("securitypolicyviolation", (e) =>
  window.fixtureViolations.push(e.violatedDirective),
);
const element = document.createElement("agenticdriver-providers");
element.transport = async (request) => {
  window.fixtureRequests.push(request.action);
  if (request.action === "disconnect")
    return { connected: false, providers: [], canConnect: false };
  if (request.action !== "snapshot")
    throw Error("This read-only fixture does not change host settings.");
  return structuredClone(state);
};
document.body.append(element);

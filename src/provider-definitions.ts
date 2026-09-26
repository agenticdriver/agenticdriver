import type {
  ProviderConnectionMethod,
  ProviderDefinition,
} from "./management-types.js";

const existingSession: ProviderConnectionMethod = {
  id: "existing-session",
  label: "Use an existing sign-in",
  description:
    "Use the official runtime's signed-in account on this host. Credentials stay with that runtime. Saving settings does not start sign-in or test a model.",
  interaction: "external",
  credentialOwner: "native-runtime",
};
const apiMethods: ProviderConnectionMethod[] = [
  {
    id: "api-key",
    label: "Enter an API key",
    description:
      "Send a key once to this host's private credential store. Stored values are never returned. Model calls use this API connection's billing.",
    interaction: "api-key",
    credentialOwner: "host",
  },
  {
    id: "secret-reference",
    label: "Use a host credential",
    description:
      "Reference an environment variable or private file on this host. Its contents stay on the host.",
    interaction: "secret-reference",
    credentialOwner: "host",
  },
];
const definitions: ProviderDefinition[] = [
  {
    kind: "codex",
    name: "Codex",
    category: "native",
    protocol: "Codex app-server",
    description: "Connect an existing official Codex CLI account.",
    methods: [existingSession],
    requirements:
      "Install the qualified Codex CLI 0.157.0 on this host and complete its official sign-in first. Select its executable and account directory under Advanced settings when needed. Other versions require adapter qualification.",
    docsUrl: "https://developers.openai.com/codex/cli/",
  },
  {
    kind: "claude-code",
    name: "Claude Code",
    category: "native",
    protocol: "Claude Code CLI",
    description: "Connect an existing official Claude Code account.",
    methods: [existingSession],
    requirements:
      "Install Claude Code and sign in through its official runtime on this host first. Account discovery is qualified against 2.1.282; a model listing is not a live execution test. Subscription use in third-party products is subject to the provider's supported integration terms.",
    docsUrl: "https://code.claude.com/docs/en/agent-sdk/overview",
  },
  {
    kind: "gemini-cli",
    name: "Gemini CLI",
    category: "native",
    protocol: "Gemini CLI",
    description: "Connect an existing official Gemini CLI account.",
    methods: [existingSession],
    requirements:
      "Install Gemini CLI and complete its official sign-in on this host first. This adapter cannot currently discover an account model inventory; select an explicit model when running. Antigravity is a separate runtime and is not this connection.",
    docsUrl: "https://geminicli.com/docs/get-started/authentication/",
  },
  {
    kind: "openai",
    name: "OpenAI API",
    category: "api",
    protocol: "OpenAI Responses",
    description: "Connect an OpenAI API account using the Responses protocol.",
    methods: apiMethods,
    docsUrl: "https://platform.openai.com/docs/api-reference/authentication",
  },
  {
    kind: "anthropic",
    name: "Anthropic API",
    category: "api",
    protocol: "Anthropic Messages",
    description:
      "Connect an Anthropic API account using the Messages protocol.",
    methods: apiMethods,
    docsUrl: "https://platform.claude.com/docs/en/api/overview",
  },
  {
    kind: "gemini",
    name: "Gemini API",
    category: "api",
    protocol: "Gemini generateContent",
    description: "Connect a Gemini API account with an API key.",
    methods: apiMethods,
    docsUrl: "https://ai.google.dev/gemini-api/docs/api-key",
  },
  {
    kind: "xai",
    name: "xAI Chat Completions",
    category: "api",
    protocol: "OpenAI Chat Completions",
    description:
      "Connect an xAI API account to use Grok through Chat Completions.",
    methods: apiMethods,
    docsUrl: "https://docs.x.ai/developers/rest-api-reference/inference/chat",
  },
  {
    kind: "xai-responses",
    name: "xAI Responses",
    category: "api",
    protocol: "OpenAI Responses",
    description: "Connect an xAI API account to use Grok through Responses.",
    methods: apiMethods,
    docsUrl:
      "https://docs.x.ai/developers/rest-api-reference/inference/responses",
  },
  {
    kind: "openai-compatible",
    name: "Compatible API or gateway",
    category: "compatible",
    protocol: "OpenAI Chat Completions",
    description:
      "Connect an explicitly chosen compatible endpoint, proxy or gateway.",
    methods: apiMethods,
    requirements:
      "An endpoint URL is required. This connection identifies the gateway account; the gateway controls its own upstream routing, credentials and billing. Configure those policies there before relying on a particular upstream account. No vendor compatibility or model availability is implied by saving a URL.",
  },
  {
    kind: "mock",
    name: "Offline demo",
    category: "fixture",
    protocol: "Synthetic fixture",
    description: "Try the SDK without an external provider or model usage.",
    methods: [
      {
        id: "offline",
        label: "Use the offline fixture",
        description: "No sign-in, credentials or external model calls.",
        interaction: "none",
        credentialOwner: "none",
      },
    ],
  },
];

/** Pure metadata. Does not inspect credentials, start a process or contact a provider. */
export function providerDefinitions(
  options: { ownedSignIn?: boolean } = {},
): ProviderDefinition[] {
  const result = structuredClone(definitions);
  if (options.ownedSignIn) {
    const codex = result.find((p) => p.kind === "codex")!;
    codex.description = "Connect an official Codex CLI account on this host.";
    codex.requirements =
      "Requires the qualified Codex CLI 0.157.0 executable on this Linux x64 host. Device sign-in creates a separate private profile; existing accounts stay unchanged. Your ChatGPT account must allow device-code sign-in.";
    codex.methods.unshift({
      id: "codex-device",
      label: "Sign in with ChatGPT",
      description:
        "Open the official device page, enter the displayed code, then confirm the verified account. Codex owns the credentials on the selected host.",
      interaction: "device-code",
      credentialOwner: "native-runtime",
    });
  }
  return result;
}

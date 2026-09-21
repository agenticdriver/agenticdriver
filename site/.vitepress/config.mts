import { defineConfig } from "vitepress";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../../", import.meta.url));
const docs = resolve(root, "docs");
const repository = "https://github.com/agenticdriver/agenticdriver";
const require = createRequire(import.meta.url);

export default defineConfig({
  srcDir: "../docs",
  title: "AgenticDriver SDK",
  description:
    "Bring your agent to your application. One SDK for local and remote execution, selected context, tools and usage.",
  lang: "en",
  cleanUrls: false,
  appearance: true,
  lastUpdated: true,
  head: [["meta", { name: "theme-color", content: "#087f73" }]],
  // Markdown stays in docs/, outside this site's isolated dependency directory.
  vite: {
    resolve: {
      alias: [
        {
          find: "vue/server-renderer",
          replacement: require.resolve("vue/server-renderer"),
        },
        {
          find: /^vue$/,
          replacement: require.resolve("vue/dist/vue.runtime.esm-bundler.js"),
        },
      ],
    },
  },
  themeConfig: {
    siteTitle: "AgenticDriver",
    nav: [
      { text: "Start", link: "/quickstart" },
      { text: "Three recipes", link: "/applications" },
      { text: "Compatibility", link: "/compatibility" },
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: repository }],
    outline: [2, 3],
    editLink: { pattern: repository + "/edit/sdk-roadmap/docs/:path" },
    sidebar: [
      {
        text: "Start building",
        items: [
          { text: "Install and connect", link: "/quickstart" },
          { text: "JavaScript and TypeScript", link: "/javascript" },
          { text: "Three application recipes", link: "/applications" },
          { text: "Provider and account setup", link: "/providers" },
          { text: "Troubleshooting", link: "/troubleshooting" },
        ],
      },
      {
        text: "Connect and authorize",
        items: [
          { text: "Local execution host", link: "/host" },
          { text: "Better Auth and AuthYard", link: "/authentication" },
          { text: "Remote deployment", link: "/deployment" },
          { text: "Discovery", link: "/discovery" },
          { text: "Inactivity and cancellation", link: "/timeouts" },
        ],
      },
      {
        text: "Build application workflows",
        items: [
          { text: "Application tools", link: "/application-tools" },
          { text: "Approvals", link: "/approvals" },
          { text: "Context and artifacts", link: "/context" },
          { text: "RAG and vector stores", link: "/retrieval" },
          { text: "PDF, Markdown and email", link: "/ingestion" },
          { text: "Sessions", link: "/sessions" },
          { text: "Durable jobs", link: "/jobs" },
          { text: "Idempotency", link: "/idempotency" },
          { text: "Capacity", link: "/scheduling" },
        ],
      },
      {
        text: "Operate and extend",
        items: [
          { text: "Usagestat integration", link: "/usagestat" },
          { text: "Usage accounting", link: "/usage" },
          { text: "Provider labels and icons", link: "/catalog" },
          { text: "Diagnostics", link: "/diagnostics" },
          { text: "Provider extensions", link: "/provider-extensions" },
          { text: "Architecture", link: "/architecture" },
          { text: "Security boundaries", link: "/security" },
          { text: "Protocol", link: "/protocol" },
          { text: "Compatibility", link: "/compatibility" },
          { text: "Migration notes", link: "/migrations" },
          { text: "Release candidates", link: "/releases" },
        ],
      },
    ],
    footer: {
      message:
        "Working v0.1 SDK. Packaged fixtures are verified; live account certification and registry release are tracked separately.",
    },
  },
  markdown: {
    languageAlias: { mjs: "javascript", mts: "typescript" },
    config(md) {
      // Keep the same Markdown useful in GitHub and the site. Source links that
      // leave docs/ go to the repository, rather than becoming broken site URLs.
      md.core.ruler.after("inline", "repository-source-links", (state) => {
        const visit = (tokens) => {
          for (const token of tokens) {
            if (token.type === "link_open") {
              const href = token.attrGet("href");
              if (href && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) {
                const [path, fragment] = href.split("#", 2);
                const target = resolve(
                  dirname(state.env.path),
                  decodeURIComponent(path),
                );
                const local = relative(docs, target);
                if (local === ".." || local.startsWith(`..${sep}`)) {
                  const source = relative(root, target).split(sep).join("/");
                  if (!source.startsWith("../"))
                    token.attrSet(
                      "href",
                      repository +
                        "/blob/sdk-roadmap/" +
                        source +
                        (fragment ? "#" + fragment : ""),
                    );
                }
              }
            }
            if (token.children) visit(token.children);
          }
        };
        visit(state.tokens);
      });
    },
  },
});

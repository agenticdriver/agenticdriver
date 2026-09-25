import type { ProviderPanelState, PanelRequest } from "./panel.js";
import type {
  HostProviderConfig,
  ConfigureProvider,
} from "./management-types.js";
import type { ProviderInfo } from "./types.js";
import type { ConnectionList } from "./connection-types.js";
export type { ProviderPanelState, PanelRequest } from "./panel.js";
export type ProviderPanelTransport = (
  request: PanelRequest,
) => Promise<unknown>;
export interface ProviderPanelElement extends HTMLElement {
  transport?: ProviderPanelTransport;
  refresh(): Promise<void>;
}

const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function assetPath(path: string): string {
  if (!/^\/(?!\/)[^\s?#\\]*$/.test(path) || path.split("/").includes(".."))
    throw new Error("Use a same-origin absolute asset or API path.");
  return path;
}
/** Embeddable markup; no host credential, inline script or framework dependency. */
export function providerPanelHtml(
  options: { apiPath?: string; modulePath?: string; id?: string } = {},
): string {
  const id = options.id ?? "agenticdriver-providers";
  return `<agenticdriver-providers id="${escape(id)}" api="${escape(assetPath(options.apiPath ?? "/api/agenticdriver-panel"))}"></agenticdriver-providers><script type="module" src="${escape(assetPath(options.modulePath ?? "/assets/agenticdriver-panel.js"))}"></script>`;
}
/** Application session cookies go only to its own backend. Host tokens never enter this transport. */
export function createPanelTransport(apiPath: string): ProviderPanelTransport {
  const path = assetPath(apiPath);
  return async (request) => {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(request),
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
    const text = await response.text();
    if (text.length > 2_000_000)
      throw new Error("The provider panel response was too large.");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("Could not read the provider panel response.");
    }
    if (!response.ok)
      throw new Error(
        typeof (value as { error?: { message?: unknown } })?.error?.message ===
          "string"
          ? (value as { error: { message: string } }).error.message
          : "The provider panel request failed.",
      );
    return value;
  };
}

const labels: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  "gemini-cli": "Gemini CLI",
  openai: "OpenAI API",
  anthropic: "Anthropic API",
  gemini: "Gemini API",
  xai: "xAI API",
  "xai-responses": "xAI Responses",
  "openai-compatible": "Compatible API",
  mock: "Offline demo",
};
const native = (kind: string) =>
  ["codex", "claude-code", "gemini-cli"].includes(kind);
const keyEnv: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
  "xai-responses": "XAI_API_KEY",
};
type Preferences = { favorites: string[]; hidden: string[]; order: string[] };
const emptyPreferences = (): Preferences => ({
  favorites: [],
  hidden: [],
  order: [],
});
const css = `
:host{--ad-bg:#252a3b;--ad-surface:#2c3245;--ad-field:#222737;--ad-line:#3a4157;--ad-fg:#e9ecf5;--ad-muted:#a6aec4;--ad-accent:#a6b6ff;--ad-good:#9ddbc2;display:block;color:var(--ad-fg);font:14px/1.5 system-ui,sans-serif;color-scheme:dark}
:host([theme=light]){--ad-bg:#fafbff;--ad-surface:#f0f2f9;--ad-field:#fff;--ad-line:#d8deee;--ad-fg:#202839;--ad-muted:#5d6980;--ad-accent:#3e52b6;--ad-good:#237a59;color-scheme:light}
*{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.45}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--ad-accent);outline-offset:3px}button{color:inherit;border:1px solid var(--ad-line);border-radius:8px;background:transparent;padding:7px 12px}button:hover:enabled{background:var(--ad-surface)}button.primary{background:var(--ad-accent);color:var(--ad-bg);border-color:transparent;font-weight:650}button.primary:hover:enabled{filter:brightness(1.08)}.quiet{border:0;padding:5px 8px}.shell{background:var(--ad-bg);border:1px solid var(--ad-line);border-radius:18px;overflow:hidden;min-height:460px;max-width:1320px;margin:auto}.top{padding:22px 26px;display:flex;justify-content:space-between;gap:16px;align-items:center;border-bottom:1px solid var(--ad-line)}.eyebrow{font-size:10px;font-weight:700;letter-spacing:.16em;color:var(--ad-muted);text-transform:uppercase}.top h2{font-size:20px;letter-spacing:-.025em;margin:4px 0 0;font-weight:600}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pill{font-size:11px;border:1px solid var(--ad-line);border-radius:20px;padding:3px 9px;color:var(--ad-muted);white-space:nowrap}.live{color:var(--ad-good)}.layout{display:grid;grid-template-columns:252px minmax(0,1fr);min-height:480px}.sidebar{background:color-mix(in srgb,var(--ad-surface) 45%,transparent);border-right:1px solid var(--ad-line);padding:12px}.side-label{font-size:11px;color:var(--ad-muted);padding:10px 10px 14px;text-transform:uppercase;letter-spacing:.07em}.provider{display:flex;align-items:center;border:1px solid transparent;border-radius:11px;margin:3px 0;padding:5px;gap:3px}.provider.selected{background:var(--ad-surface);border-color:var(--ad-line)}.provider button.select{display:flex;gap:12px;align-items:center;flex:1;min-width:0;text-align:left;border:0;padding:10px 6px}.avatar{width:32px;height:32px;flex-shrink:0;display:grid;place-items:center;font-size:13px;font-weight:650;color:var(--ad-accent);background:var(--ad-field);border-radius:9px}.avatar img{width:24px;height:24px;object-fit:contain}.provider-copy{min-width:0}.provider-copy strong{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.provider-copy small{font-size:11px;color:var(--ad-muted);display:block}.switch{width:32px;height:19px;flex:0 0 32px;padding:2px!important;border:0;border-radius:18px;background:var(--ad-line);position:relative}.switch:before{content:"";width:15px;height:15px;display:block;border-radius:50%;background:var(--ad-muted)}.switch[aria-checked=true]{background:var(--ad-accent)}.switch[aria-checked=true]:before{background:var(--ad-bg);margin-left:13px}.detail{padding:26px 30px;min-width:0}.detail-head{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:20px}.detail-head>div{min-width:0;overflow-wrap:anywhere}.detail-head h3{font-size:19px;margin:0;font-weight:600}.muted{color:var(--ad-muted)}.small{font-size:12px}.tabs{display:flex;gap:4px;border-bottom:1px solid var(--ad-line);margin:22px 0}.tabs button{border:0;border-radius:0;padding:10px 16px;color:var(--ad-muted);border-bottom:2px solid transparent}.tabs button[aria-selected=true]{color:var(--ad-accent);border-bottom-color:var(--ad-accent)}.group{border:1px solid var(--ad-line);border-radius:12px;overflow:hidden;margin:14px 0}.field{display:grid;grid-template-columns:minmax(130px,1fr) minmax(160px,1fr);gap:20px;padding:16px 18px;align-items:center}.field+.field{border-top:1px solid var(--ad-line)}.field label{font-weight:550;display:block}.hint{color:var(--ad-muted);font-size:12px;font-weight:400;margin:4px 0 0}input,select,textarea{border:1px solid var(--ad-line);border-radius:8px;padding:8px 10px;background:var(--ad-field);color:var(--ad-fg);width:100%;min-width:0}input:disabled{opacity:.65}input[type=checkbox]{width:16px;height:16px;accent-color:var(--ad-accent)}textarea{resize:vertical;min-height:90px}.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.model-access{flex-wrap:wrap}.model-access .inline{white-space:nowrap}.model-toolbar{margin-bottom:12px;display:flex;gap:14px;align-items:center}.model-toolbar input{max-width:260px}.models{border-top:1px solid var(--ad-line);margin-top:14px}.model{display:flex;align-items:center;gap:8px;padding:11px 0;border-bottom:1px solid var(--ad-line)}.model.hidden-model{opacity:.65}.model .model-name{flex:1;min-width:0;text-align:left;border:0;font:12px/1.5 ui-monospace,monospace;overflow-wrap:anywhere;padding:4px}.model .star{font-size:18px;width:27px;padding:2px;border:0}.star.favorite{color:#e9c979}.icon-button{font-size:12px;padding:3px 6px}.section-label{font-size:12px;color:var(--ad-muted);margin:22px 0 10px}.notice{border:1px solid var(--ad-line);border-radius:10px;padding:12px 15px;color:var(--ad-muted);font-size:12px;margin:12px 0}.error{border-color:#b5727c;color:#f2b7bf;margin:16px 24px}.success{color:var(--ad-good)}.empty{max-width:840px;margin:auto;padding:40px 32px}.empty h3{font-size:28px;line-height:1.25;letter-spacing:-.035em;margin:10px 0}.empty p{max-width:570px;color:var(--ad-muted)}.setup-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:26px}.setup-card{background:var(--ad-surface);border:1px solid var(--ad-line);border-radius:12px;padding:22px}.setup-card h4{font-size:15px;margin:4px 0 10px}.step{font-size:11px;color:var(--ad-accent);font-weight:600}.command{font:12px/1.6 ui-monospace,monospace;background:var(--ad-field);border-radius:8px;padding:12px;margin:14px 0;white-space:pre-wrap;overflow-wrap:anywhere}.connect-form{margin:24px 0}.connect-form label{display:block;margin-bottom:8px;font-weight:550}.connect-form textarea{font:12px/1.6 ui-monospace,monospace}.footer{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-top:18px}.inline{display:flex;align-items:center;gap:8px}.host-label{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.links{margin-top:24px;padding-top:18px;border-top:1px solid var(--ad-line)}.connections{padding:10px 0;border-bottom:1px solid var(--ad-line);display:flex;justify-content:space-between;gap:16px}.connection-meta{font-size:11px;color:var(--ad-muted);overflow-wrap:anywhere}.new-provider{border:1px dashed var(--ad-line);width:100%;margin-top:15px;text-align:left}.save-row{justify-content:flex-end}.loading{padding:50px;text-align:center;color:var(--ad-muted)}
@media(max-width:760px){.top{padding:18px;align-items:flex-start;flex-wrap:wrap}.layout{grid-template-columns:1fr}.sidebar{border-right:0;border-bottom:1px solid var(--ad-line);display:flex;gap:6px;overflow:auto;align-items:center}.side-label{display:none}.provider{flex:0 0 205px}.new-provider{width:auto;white-space:nowrap;margin:0}.detail{padding:22px 18px}.field{grid-template-columns:1fr;gap:9px;padding:14px}.setup-grid{grid-template-columns:1fr}.empty{padding:26px 20px}.empty h3{font-size:25px}.host-label{max-width:180px}.model{gap:3px}.model-toolbar{align-items:flex-start;flex-wrap:wrap}.model .model-name{font-size:11px}.footer{flex-wrap:wrap}}
`;

export function registerProviderPanel(
  registry: CustomElementRegistry = customElements,
): void {
  if (registry.get("agenticdriver-providers")) return;
  class Panel extends HTMLElement implements ProviderPanelElement {
    transport?: ProviderPanelTransport;
    private root = this.attachShadow({ mode: "open" });
    private state?: ProviderPanelState;
    private selected = "";
    private tab = "runtime";
    private query = "";
    private busy = false;
    private message = "";
    private failure = "";
    private adding = false;
    private draft?: HostProviderConfig;
    private apiKey = "";
    private generation = 0;
    private bound = false;
    private pendingFocus?: string;
    private links?: ConnectionList;
    private invite?: { invitation: string; expiresAt: string };
    private preferenceScope = crypto.randomUUID();
    private preferenceCache = new Map<string, Preferences>();
    connectedCallback() {
      if (!this.transport && this.hasAttribute("api"))
        this.transport = createPanelTransport(this.getAttribute("api")!);
      if (!this.bound) {
        this.bound = true;
        this.root.addEventListener("click", (event) => {
          void this.onClick(event).catch((error) => this.fail(error));
        });
        this.root.addEventListener("input", (event) => this.input(event));
        this.root.addEventListener("change", (event) => this.change(event));
        this.root.addEventListener("keydown", (event) => {
          if (!(event instanceof KeyboardEvent) || this.busy) return;
          const target = event.target as HTMLElement;
          if (target.getAttribute("role") !== "tab") return;
          const tabs = [
            ...this.root.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
          ];
          const index = tabs.indexOf(target as HTMLButtonElement);
          const next =
            event.key === "ArrowRight"
              ? (index + 1) % tabs.length
              : event.key === "ArrowLeft"
                ? (index + tabs.length - 1) % tabs.length
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : -1;
          if (next < 0) return;
          event.preventDefault();
          const tab = tabs[next]!;
          tab.click();
          this.root
            .querySelector<HTMLElement>(`[data-tab="${tab.dataset.tab}"]`)
            ?.focus();
        });
      }
      void this.refresh();
    }
    disconnectedCallback() {
      this.generation++;
    }
    private async call(request: PanelRequest) {
      if (!this.transport)
        throw new Error(
          "Connect this component to your application's provider panel backend.",
        );
      return this.transport(request);
    }
    private fail(error: unknown) {
      this.failure =
        error instanceof Error ? error.message : "The request failed.";
      this.busy = false;
      this.render();
    }
    private accept(value: unknown) {
      const state = value as ProviderPanelState;
      if (
        typeof state?.connected !== "boolean" ||
        !Array.isArray(state.providers)
      )
        throw new Error("The panel returned invalid connection state.");
      this.state = state;
      this.failure = state.connectionError ?? "";
      if (!state.providers.some((p) => p.id === this.selected))
        this.selected = state.providers[0]?.id ?? "";
      this.draft = structuredClone(
        state.management?.providers.find((p) => p.id === this.selected),
      );
      this.adding = false;
      this.apiKey = "";
      this.links = undefined;
      this.invite = undefined;
    }
    async refresh() {
      const generation = ++this.generation;
      this.busy = true;
      this.failure = "";
      this.render();
      try {
        const state = await this.call({ action: "snapshot", refresh: true });
        if (generation === this.generation) this.accept(state);
      } catch (error) {
        if (generation === this.generation)
          this.failure =
            error instanceof Error ? error.message : "Could not connect.";
      } finally {
        if (generation === this.generation) {
          this.busy = false;
          this.render();
        }
      }
    }
    private preferences(): Preferences {
      const key = `agenticdriver.models.${this.state?.connection?.id ?? this.preferenceScope}.${this.selected}`;
      if (!this.preferenceCache.has(key)) {
        let value = emptyPreferences();
        try {
          const stored = JSON.parse(localStorage.getItem(key) ?? "null");
          if (
            stored &&
            ["favorites", "hidden", "order"].every(
              (k) =>
                Array.isArray(stored[k]) &&
                stored[k].length <= 1000 &&
                stored[k].every((v: unknown) => typeof v === "string"),
            )
          )
            value = stored;
        } catch {
          /* Private browsing or unavailable storage: use in-memory preferences. */
        }
        this.preferenceCache.set(key, value);
      }
      return this.preferenceCache.get(key)!;
    }
    private savePreferences(value: Preferences) {
      const key = `agenticdriver.models.${this.state?.connection?.id ?? this.preferenceScope}.${this.selected}`;
      this.preferenceCache.set(key, value);
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* In-memory preferences remain usable. */
      }
      this.dispatchEvent(
        new CustomEvent("agenticdriver:preferences-changed", {
          detail: { provider: this.selected, ...value },
          bubbles: true,
          composed: true,
        }),
      );
      this.render();
    }
    private models(provider?: ProviderInfo): string[] {
      const all = [
        ...new Set([
          ...(provider?.modelCatalog?.models ?? []),
          ...(this.draft?.models ?? provider?.models ?? []),
        ]),
      ];
      const prefs = this.preferences();
      return all.sort(
        (a, b) =>
          Number(prefs.favorites.includes(b)) -
            Number(prefs.favorites.includes(a)) ||
          (prefs.order.indexOf(a) < 0 ? 1001 : prefs.order.indexOf(a)) -
            (prefs.order.indexOf(b) < 0 ? 1001 : prefs.order.indexOf(b)) ||
          a.localeCompare(b),
      );
    }
    private async save(provider: HostProviderConfig) {
      const revision = this.state?.management?.revision;
      if (!revision)
        throw new Error("Management access is required to edit host settings.");
      this.busy = true;
      this.failure = "";
      this.render();
      const change: ConfigureProvider = {
        revision,
        provider,
        ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      };
      try {
        this.accept(await this.call({ action: "configure", change }));
        this.selected = provider.id;
        this.draft = structuredClone(
          this.state?.management?.providers.find((p) => p.id === provider.id),
        );
        this.message =
          "Settings saved. Active runs continue with their original settings.";
      } finally {
        this.apiKey = "";
        this.busy = false;
        this.render();
      }
    }
    private input(event: Event) {
      const input = event.target as HTMLInputElement;
      if (input.dataset.field === "query") {
        this.query = input.value;
        this.render();
        return;
      }
      if (input.dataset.field === "apiKey") {
        this.apiKey = input.value;
        return;
      }
      if (!this.draft || !input.dataset.config) return;
      const config = this.draft as unknown as Record<string, unknown>;
      if (input.dataset.config === "env")
        config.apiKeyRef = { env: input.value };
      else if (input.dataset.config === "file")
        config.apiKeyRef = { file: input.value };
      else if (input.value) config[input.dataset.config] = input.value;
      else delete config[input.dataset.config];
    }
    private change(event: Event) {
      const target = event.target as HTMLSelectElement;
      if (target.dataset.field === "kind") {
        const kind = target.value,
          id = this.draft?.id ?? "";
        this.draft = {
          id,
          kind,
          ...(native(kind) || kind === "mock"
            ? {}
            : { apiKeyRef: { env: keyEnv[kind] ?? "PROVIDER_API_KEY" } }),
        } as HostProviderConfig;
        this.render();
      }
      if (target.dataset.field === "setup-kind") {
        const command = this.root.querySelector(".command");
        if (command)
          command.textContent = `agenticdriver setup --provider ${target.value} --manage`;
      }
    }
    private async onClick(event: Event) {
      const button = (event.target as Element).closest<HTMLButtonElement>(
        "button[data-action]",
      );
      if (!button || button.disabled || this.busy) return;
      const action = button.dataset.action!,
        model = button.dataset.model;
      this.failure = "";
      this.message = "";
      if (action === "refresh") return this.refresh();
      if (action === "select") {
        this.selected = button.dataset.id!;
        this.query = "";
        this.adding = false;
        this.apiKey = "";
        this.draft = structuredClone(
          this.state?.management?.providers.find((p) => p.id === this.selected),
        );
        this.render();
        return;
      }
      if (action === "tab") {
        this.tab = button.dataset.tab!;
        this.render();
        return;
      }
      if (action === "add") {
        this.adding = true;
        this.draft = { id: "", kind: "codex" };
        this.tab = "runtime";
        this.render();
        return;
      }
      if (action === "save" && this.draft) return this.save(this.draft);
      if (action === "enable") {
        const p = this.state?.management?.providers.find(
          (p) => p.id === button.dataset.id,
        );
        if (p) return this.save({ ...p, enabled: p.enabled === false });
      }
      if (action === "allow-all" && this.draft) {
        const p = { ...this.draft };
        if (p.models === undefined)
          p.models = this.models(
            this.state?.providers.find((p) => p.id === this.selected),
          );
        else delete p.models;
        return this.save(p as HostProviderConfig);
      }
      if (action === "access" && this.draft && model) {
        const models =
          this.draft.models ??
          this.models(
            this.state?.providers.find((p) => p.id === this.selected),
          );
        return this.save({
          ...this.draft,
          models: models.includes(model)
            ? models.filter((m) => m !== model)
            : [...models, model],
        });
      }
      if (action === "custom" && this.draft) {
        const input = this.root.querySelector<HTMLInputElement>(
          "[data-field=custom]",
        )!;
        const model = input.value.trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/.test(model))
          throw new Error("Enter a valid explicit model ID.");
        return this.save({
          ...this.draft,
          models: [
            ...new Set([
              ...(this.draft.models ??
                this.models(
                  this.state?.providers.find((p) => p.id === this.selected),
                )),
              model,
            ]),
          ],
        });
      }
      if (action === "choose" && model) {
        this.dispatchEvent(
          new CustomEvent("agenticdriver:model-selected", {
            detail: { provider: this.selected, model },
            bubbles: true,
            composed: true,
          }),
        );
        this.message = `${model} selected.`;
        this.render();
        return;
      }
      if (["favorite", "visibility", "up", "down"].includes(action) && model) {
        const prefs = this.preferences();
        if (action === "favorite" || action === "visibility") {
          const key = action === "favorite" ? "favorites" : "hidden";
          prefs[key] = prefs[key].includes(model)
            ? prefs[key].filter((m) => m !== model)
            : [...prefs[key], model];
        } else {
          const order = this.models(
            this.state?.providers.find((p) => p.id === this.selected),
          );
          const i = order.indexOf(model),
            next = i + (action === "up" ? -1 : 1);
          if (i >= 0 && next >= 0 && next < order.length)
            [order[i], order[next]] = [order[next]!, order[i]!];
          prefs.order = order;
        }
        this.savePreferences(prefs);
        return;
      }
      if (action === "connect") {
        const invitation =
          this.root
            .querySelector<HTMLTextAreaElement>("[data-field=invitation]")
            ?.value.trim() ?? "";
        if (!invitation)
          throw new Error(
            "Paste an invitation from the host you want to connect.",
          );
        this.busy = true;
        this.render();
        try {
          this.accept(await this.call({ action: "connect", invitation }));
        } finally {
          this.busy = false;
          this.render();
        }
        return;
      }
      if (action === "disconnect") {
        this.busy = true;
        this.render();
        try {
          this.accept(await this.call({ action: "disconnect" }));
        } finally {
          this.busy = false;
          this.render();
        }
        return;
      }
      if (action === "connections") {
        this.busy = true;
        this.render();
        try {
          this.links = (await this.call({
            action: "connections",
          })) as ConnectionList;
        } finally {
          this.busy = false;
          this.render();
        }
        return;
      }
      if (action === "revoke") {
        this.busy = true;
        this.render();
        try {
          await this.call({ action: "revoke", id: button.dataset.id! });
          this.links = (await this.call({
            action: "connections",
          })) as ConnectionList;
        } finally {
          this.busy = false;
          this.render();
        }
        return;
      }
      if (action === "invite") {
        const subject =
          this.root
            .querySelector<HTMLInputElement>("[data-field=subject]")
            ?.value.trim() || "connected-app";
        this.busy = true;
        this.render();
        try {
          this.invite = (await this.call({
            action: "invite",
            subject,
            providers: this.state?.providers.map((p) => p.id) ?? [],
            manageProviders: false,
          })) as { invitation: string; expiresAt: string };
        } finally {
          this.busy = false;
          this.render();
        }
        return;
      }
      if (action === "copy-invite" && this.invite) {
        await navigator.clipboard.writeText(this.invite.invitation);
        this.message = "Invitation copied. It can be used once.";
        this.render();
      }
    }
    private avatar(provider: ProviderInfo) {
      const presentation = this.state?.presentations?.[provider.id];
      if (presentation?.icon.kind === "asset") {
        try {
          const path = assetPath(presentation.icon.asset.src);
          return `<span class="avatar"><img src="${escape(path)}" alt="${escape(presentation.icon.alt)}"></span>`;
        } catch {
          /* Fall back to initials if an asset is not local. */
        }
      }
      return `<span class="avatar" aria-hidden="true">${escape(presentation?.icon.kind === "fallback" ? presentation.icon.text : provider.name.slice(0, 2).toUpperCase())}</span>`;
    }
    private field(
      label: string,
      key: string,
      value: string | undefined,
      hint = "",
      disabled = false,
      password = false,
    ) {
      return `<div class="field"><div><label for="field-${key}">${escape(label)}</label>${hint ? `<p class="hint">${escape(hint)}</p>` : ""}</div><input id="field-${key}" ${key === "apiKey" ? 'data-field="apiKey"' : `data-config="${key}"`} value="${escape(value)}" ${password ? 'type="password" autocomplete="new-password"' : 'autocomplete="off" spellcheck="false"'} ${disabled ? "disabled" : ""}></div>`;
    }
    private disconnected() {
      return `<div class="empty"><div class="eyebrow">YOUR AGENTS. YOUR ACCOUNTS.</div><h3>Connect your AgenticDriver.</h3><p>Use the providers already signed in on your computer, or connect an execution host on another machine.</p><div class="setup-grid"><section class="setup-card"><span class="step">01 / START A LOCAL HOST</span><h4>Use this computer</h4><label class="small muted" for="setup-kind">Provider</label><select id="setup-kind" data-field="setup-kind">${Object.entries(
        labels,
      )
        .filter(([k]) => k !== "openai-compatible")
        .map(([k, v]) => `<option value="${k}">${v}</option>`)
        .join(
          "",
        )}</select><pre class="command">agenticdriver setup --provider codex --manage</pre><p class="small">Run this in a terminal on the provider machine. Keep it running and copy the invitation it prints.</p></section><section class="setup-card"><span class="step">02 / OR USE A REMOTE HOST</span><h4>Connect another machine</h4><p class="small">Ask its operator for an AgenticDriver invitation. The invitation includes the host address and your connection permissions.</p><div class="notice">Remote hosts use HTTPS. For hosted apps, the address must be reachable from the app's backend.</div><p class="small">Already running a host? Create an invitation with <code>agenticdriver pair</code>.</p></section></div><div class="connect-form">${this.state?.connection && this.state.canDisconnect ? '<div class="notice">A saved connection is unavailable. <button data-action="disconnect">Forget saved connection</button></div>' : ""}<label for="invitation">Connection invitation</label><textarea id="invitation" data-field="invitation" placeholder="ad1.…" autocomplete="off" spellcheck="false" aria-describedby="invite-hint"></textarea><div class="footer"><span class="hint" id="invite-hint">Used once. Your app keeps the connection credential privately.</span><button class="primary" data-action="connect" ${this.busy || this.state?.canConnect === false ? "disabled" : ""}>${this.busy ? "Connecting…" : "Connect host →"}</button></div>${this.state?.canConnect === false ? '<p class="hint">This application manages connections outside this panel.</p>' : ""}</div></div>`;
    }
    private runtime(provider?: ProviderInfo) {
      const p = this.draft,
        readonly = !this.state?.management || p?.kind === "extension";
      if (!p)
        return `<div class="notice">Connected for execution. Management access is required to edit this host's provider settings.</div><div class="group">${this.field("Provider instance", "id", provider?.id, "", true)}${this.field("Connection mode", "mode", provider?.authMode, "", true)}</div>`;
      let fields = this.field(
        "Display name",
        "name",
        p.name ?? "",
        "A label for this provider connection.",
        readonly,
      );
      if (this.adding)
        fields += this.field(
          "Instance ID",
          "id",
          p.id,
          "Unique on this host. Use a new ID for a different account.",
        );
      fields += this.field(
        "Account ID",
        "accountId",
        p.accountId,
        "Stable account identity used for usage tracking.",
        !this.adding,
      );
      if (native(p.kind))
        fields +=
          this.field(
            "Binary path",
            "binary",
            "binary" in p ? p.binary : undefined,
            "Executable on the connected host. Empty uses its standard command.",
          ) +
          this.field(
            "Account directory",
            "accountDirectory",
            "accountDirectory" in p ? p.accountDirectory : undefined,
            "Use the provider's signed-in account directory on that host.",
          );
      if (p.kind === "codex")
        fields += this.field(
          "Reasoning effort",
          "reasoningEffort",
          p.reasoningEffort,
          "Optional. Supported values depend on the selected model.",
        );
      if ("apiKeyRef" in p) {
        fields += this.field(
          "API endpoint",
          "baseUrl",
          p.baseUrl,
          "Optional vendor endpoint. Compatible APIs require an explicit URL.",
        );
        if ("env" in p.apiKeyRef)
          fields += this.field(
            "Credential environment variable",
            "env",
            p.apiKeyRef.env,
            "Read from the host environment.",
          );
        else if ("file" in p.apiKeyRef)
          fields += this.field(
            "Credential file",
            "file",
            p.apiKeyRef.file,
            "Private file on the host. Its contents are never returned.",
          );
        fields += this.field(
          "Replace API key",
          "apiKey",
          this.apiKey,
          "Write only. Leave empty to keep the current credential.",
          false,
          true,
        );
      }
      return `${this.adding ? `<label for="provider-kind" class="small muted">Provider type</label><select id="provider-kind" data-field="kind">${this.state?.management?.supportedKinds.map((k) => `<option value="${escape(k)}" ${p.kind === k ? "selected" : ""}>${escape(labels[k] ?? k)}</option>`).join("")}</select>` : ""}<div class="group">${fields}</div>${native(p.kind) ? '<p class="hint">Native sign-in and installation happen through the provider’s official runtime on the host.</p>' : ""}<div class="footer save-row"><button class="primary" data-action="save" ${this.busy || readonly ? "disabled" : ""}>${this.busy ? "Saving…" : "Save settings"}</button></div>`;
    }
    private modelList(provider?: ProviderInfo) {
      const models = this.models(provider),
        prefs = this.preferences(),
        p = this.draft;
      const unrestricted = (p ? p.models : provider?.models) === undefined,
        allowed = p?.models ?? provider?.models;
      const canManage = Boolean(
        this.state?.management && p && p.kind !== "extension",
      );
      return `<div class="row model-access"><div><strong>Model access</strong><p class="hint">Reported models stay visible. Permissions apply to new runs.</p></div><label class="inline small"><span>Allow all models</span><button class="switch" role="switch" aria-label="Allow all models" aria-checked="${unrestricted}" data-action="allow-all" ${!canManage || this.busy ? "disabled" : ""}></button></label></div><div class="notice">${provider?.modelCatalog?.source === "provider" ? "Inventory reported by this provider. A listed model has not necessarily passed a live test." : "The provider has not supplied a model inventory. Configured IDs are shown without an availability claim."}</div><div class="model-toolbar"><input aria-label="Filter models" data-field="query" value="${escape(this.query)}" placeholder="Filter models…"><span class="small muted">${models.length} models · ${prefs.favorites.filter((m) => models.includes(m)).length} favorites</span></div><p class="hint">Stars, visibility and ordering are saved on this device. Access switches change the host provider settings.</p>${this.state?.management && !this.state.management.executionProviders?.includes(provider?.id ?? "") ? '<p class="hint">This connection has management access. Execution access to this provider is not granted or has not been reported by the host.</p>' : ""}<div class="models">${
        models
          .filter((m) => m.toLowerCase().includes(this.query.toLowerCase()))
          .map((model) => {
            const enabled = unrestricted || allowed?.includes(model);
            const canSelect =
              !this.state?.management ||
              this.state.management.executionProviders?.includes(
                provider?.id ?? "",
              ) === true;
            return `<div class="model ${prefs.hidden.includes(model) ? "hidden-model" : ""}"><button class="star ${prefs.favorites.includes(model) ? "favorite" : ""}" data-action="favorite" data-model="${escape(model)}" aria-label="Favorite ${escape(model)}" aria-pressed="${prefs.favorites.includes(model)}">${prefs.favorites.includes(model) ? "★" : "☆"}</button><button class="model-name" data-action="choose" data-model="${escape(model)}" ${!enabled || !canSelect || p?.enabled === false ? "disabled" : ""}>${escape(model)}</button><button class="quiet icon-button" data-action="visibility" data-model="${escape(model)}" aria-label="${prefs.hidden.includes(model) ? "Show" : "Hide"} ${escape(model)}">${prefs.hidden.includes(model) ? "Show" : "Hide"}</button><button class="quiet icon-button" data-action="up" data-model="${escape(model)}" aria-label="Move ${escape(model)} up">↑</button><button class="quiet icon-button" data-action="down" data-model="${escape(model)}" aria-label="Move ${escape(model)} down">↓</button><button class="switch" role="switch" aria-label="Allow ${escape(model)}" aria-checked="${Boolean(enabled)}" data-action="access" data-model="${escape(model)}" ${!canManage || this.busy ? "disabled" : ""}></button></div>`;
          })
          .join("") ||
        '<p class="muted small">No models match this view. Refresh the provider or configure an explicit model ID.</p>'
      }</div>${canManage ? '<div class="section-label">Add an explicit model to the connection allowlist</div><div class="inline"><input data-field="custom" aria-label="Custom model ID" placeholder="Model ID"><button data-action="custom">Add model</button></div><p class="hint">Adding an ID does not verify availability. This switches all-model access to an explicit allowlist.</p>' : ""}`;
    }
    private connectionSection() {
      if (!this.state?.canInvite) return "";
      return `<section class="links"><div class="row"><div><strong>Connect another application</strong><p class="hint">New invitations grant execution access to these provider instances.</p></div><button data-action="connections">Manage connections</button></div><div class="inline" style="margin-top:14px"><input data-field="subject" aria-label="Application name" placeholder="Application name"><button data-action="invite">Create invitation</button></div>${this.invite ? `<label for="new-invite" class="section-label">One-use invitation · expires ${escape(new Date(this.invite.expiresAt).toLocaleTimeString())}</label><textarea id="new-invite" readonly>${escape(this.invite.invitation)}</textarea><button data-action="copy-invite">Copy invitation</button>` : ""}${this.links ? [...this.links.connections, ...this.links.invitations].map((link) => `<div class="connections"><div><strong>${escape(link.grant.subject)}</strong><div class="connection-meta">${escape(link.grant.providers.join(", ") || "Management only")} · expires ${escape(new Date(link.expiresAt).toLocaleDateString())}</div></div><button data-action="revoke" data-id="${escape(link.id)}">Revoke</button></div>`).join("") || '<p class="hint">No active paired connections.</p>' : ""}</section>`;
    }
    private render() {
      const focused = this.root.activeElement as HTMLInputElement | null,
        focusField = focused?.dataset.field,
        selection = focused?.selectionStart;
      const focusSelector =
        focused &&
        [
          "id",
          "data-field",
          "data-config",
          "data-action",
          "data-id",
          "data-model",
          "data-tab",
        ]
          .filter((name) => focused.hasAttribute(name))
          .map(
            (name) => `[${name}="${CSS.escape(focused.getAttribute(name)!)}"]`,
          )
          .join("");
      if (focusSelector && this.busy) this.pendingFocus = focusSelector;
      const state = this.state,
        selected = state?.providers.find((p) => p.id === this.selected);
      const connected = state?.connected === true;
      const header = `<header class="top"><div><div class="eyebrow">AgenticDriver</div><h2>Providers & connections</h2></div><div class="actions">${connected ? `<span class="pill live host-label" title="${escape(state.connection?.url ?? "")}">● ${escape(state.connection?.label ?? "Connected host")}</span><button data-action="refresh" ${this.busy ? "disabled" : ""} aria-label="Refresh providers">↻ Refresh</button>${state.canDisconnect ? '<button data-action="disconnect">Disconnect</button>' : ""}` : `<span class="pill">Not connected</span>${state?.connection ? '<button data-action="refresh">Retry connection</button>' : ""}`}</div></header>`;
      let content: string;
      if (!state && this.busy)
        content =
          '<div class="loading" role="status">Loading your connection…</div>';
      else if (!connected) content = this.disconnected();
      else
        content = `<div class="layout"><aside class="sidebar" aria-label="Provider instances"><div class="side-label">${state.providers.length} connected instances</div>${state.providers
          .map((provider) => {
            const config = state.management?.providers.find(
              (p) => p.id === provider.id,
            );
            return `<div class="provider ${provider.id === this.selected && !this.adding ? "selected" : ""}"><button class="select" data-action="select" data-id="${escape(provider.id)}" aria-pressed="${provider.id === this.selected && !this.adding}">${this.avatar(provider)}<span class="provider-copy"><strong>${escape(provider.name)}</strong><small>${config?.enabled === false ? "Disabled" : provider.authMode === "cli-session" ? "Subscription / local account" : provider.authMode === "api-key" ? "API connection" : "Offline fixture"}</small><small>${provider.modelCatalog?.models.length ?? 0} reported models</small></span></button>${config && config.kind !== "extension" ? `<button class="switch" role="switch" aria-label="Enable ${escape(provider.name)}" aria-checked="${config.enabled !== false}" data-action="enable" data-id="${escape(provider.id)}" ${this.busy ? "disabled" : ""}></button>` : ""}</div>`;
          })
          .join(
            "",
          )}${state.management ? '<button class="new-provider" data-action="add">＋ Add provider</button>' : ""}</aside><main class="detail"><div class="detail-head"><div><h3>${this.adding ? "Add a provider" : escape(selected?.name ?? "No providers granted")}</h3><div class="hint">${this.adding ? "Configure an account on the connected host." : escape(this.draft?.accountId ?? selected?.id ?? "Ask the host operator for a provider grant.")}</div></div>${!this.adding && selected?.health ? `<span class="pill">${escape(selected.health.status)}</span>` : ""}</div>${!this.adding && selected?.health ? `<p class="hint">${escape(selected.health.message)} · Checked ${escape(new Date(selected.health.checkedAt).toLocaleTimeString())}</p>` : ""}${!this.adding && selected ? `<div class="tabs" role="tablist" aria-label="Provider settings"><button role="tab" id="tab-runtime" aria-controls="tab-content" tabindex="${this.tab === "runtime" ? 0 : -1}" aria-selected="${this.tab === "runtime"}" data-action="tab" data-tab="runtime">Settings</button><button role="tab" id="tab-models" aria-controls="tab-content" tabindex="${this.tab === "models" ? 0 : -1}" aria-selected="${this.tab === "models"}" data-action="tab" data-tab="models">Models <span class="small">${this.models(selected).length}</span></button></div>` : ""}${!this.adding && selected ? `<div id="tab-content" role="tabpanel" aria-labelledby="tab-${this.tab}">` : ""}${this.tab === "models" && !this.adding ? this.modelList(selected) : this.runtime(selected)}${!this.adding && selected ? "</div>" : ""}${this.message ? `<p class="small success" role="status">${escape(this.message)}</p>` : ""}${this.connectionSection()}</main></div>`;
      this.root.innerHTML = `<style>${css}</style><section class="shell" aria-label="AgenticDriver provider management">${header}${this.failure ? `<div class="notice error" role="alert">${escape(this.failure)}</div>` : ""}${content}</section>`;
      if (focusField === "query") {
        const input = this.root.querySelector<HTMLInputElement>(
          '[data-field="query"]',
        );
        input?.focus();
        if (selection !== null && selection !== undefined)
          input?.setSelectionRange(selection, selection);
      } else {
        const selector = focusSelector || this.pendingFocus;
        if (
          selector &&
          (document.activeElement === this ||
            document.activeElement === document.body)
        )
          this.root.querySelector<HTMLElement>(selector)?.focus();
      }
      if (!this.busy) this.pendingFocus = undefined;
    }
  }
  registry.define("agenticdriver-providers", Panel);
}
if (typeof customElements !== "undefined") registerProviderPanel();

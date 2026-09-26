const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function assetPath(path) {
    if (!/^\/(?!\/)[^\s?#\\]*$/.test(path) || path.split("/").includes(".."))
        throw new Error("Use a same-origin absolute asset or API path.");
    return path;
}
/** Embeddable markup; no host credential, inline script or framework dependency. */
export function providerPanelHtml(options = {}) {
    const id = options.id ?? "agenticdriver-providers";
    return `<agenticdriver-providers id="${escape(id)}" api="${escape(assetPath(options.apiPath ?? "/api/agenticdriver-panel"))}"></agenticdriver-providers><script type="module" src="${escape(assetPath(options.modulePath ?? "/assets/agenticdriver-panel.js"))}"></script>`;
}
/** Application session cookies go only to its own backend. Host tokens never enter this transport. */
export function createPanelTransport(apiPath) {
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
        let value;
        try {
            value = JSON.parse(text);
        }
        catch {
            throw new Error("Could not read the provider panel response.");
        }
        if (!response.ok)
            throw new Error(typeof value?.error?.message ===
                "string"
                ? value.error.message
                : "The provider panel request failed.");
        return value;
    };
}
const labels = {
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
const native = (kind) => ["codex", "claude-code", "gemini-cli"].includes(kind);
const categories = {
    native: "Native account",
    api: "API account",
    compatible: "Custom endpoint",
    fixture: "Offline",
};
const setupInteractions = new Set([
    "device-code",
    "external",
    "api-key",
    "secret-reference",
    "none",
]);
function helpLink(url) {
    if (!url)
        return "";
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password)
            return "";
        return `<a href="${escape(parsed.href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Official setup documentation ↗</a>`;
    }
    catch {
        return "";
    }
}
const keyEnv = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    gemini: "GEMINI_API_KEY",
    xai: "XAI_API_KEY",
    "xai-responses": "XAI_API_KEY",
};
const emptyPreferences = () => ({
    favorites: [],
    hidden: [],
    order: [],
});
const css = `
.invitation-actions{margin-top:14px}.remove-provider{margin-top:22px;padding-top:18px;border-top:1px solid var(--ad-line)}

.setup-attempts{padding:20px;display:grid;gap:16px;border-bottom:1px solid var(--ad-border,#343b52)}.setup-attempts .command{font-size:1.35rem;letter-spacing:.12em;white-space:pre-wrap;overflow-wrap:anywhere}.setup-attempts p{overflow-wrap:anywhere}.setup-attempts h4{margin:12px 0}.setup-attempts a{color:inherit;text-decoration:underline}

:host{--ad-bg:#252a3b;--ad-surface:#2c3245;--ad-field:#222737;--ad-line:#3a4157;--ad-fg:#e9ecf5;--ad-muted:#a6aec4;--ad-accent:#a6b6ff;--ad-good:#9ddbc2;display:block;color:var(--ad-fg);font:14px/1.5 system-ui,sans-serif;color-scheme:dark}
:host([theme=light]){--ad-bg:#fafbff;--ad-surface:#f0f2f9;--ad-field:#fff;--ad-line:#d8deee;--ad-fg:#202839;--ad-muted:#5d6980;--ad-accent:#3e52b6;--ad-good:#237a59;color-scheme:light}
*{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.45}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--ad-accent);outline-offset:3px}button{color:inherit;border:1px solid var(--ad-line);border-radius:8px;background:transparent;padding:7px 12px}button:hover:enabled{background:var(--ad-surface)}button.primary{background:var(--ad-accent);color:var(--ad-bg);border-color:transparent;font-weight:650}button.primary:hover:enabled{filter:brightness(1.08)}.quiet{border:0;padding:5px 8px}.shell{background:var(--ad-bg);border:1px solid var(--ad-line);border-radius:18px;overflow:hidden;min-height:460px;max-width:1320px;margin:auto}.top{padding:22px 26px;display:flex;justify-content:space-between;gap:16px;align-items:center;border-bottom:1px solid var(--ad-line)}.eyebrow{font-size:10px;font-weight:700;letter-spacing:.16em;color:var(--ad-muted);text-transform:uppercase}.top h2{font-size:20px;letter-spacing:-.025em;margin:4px 0 0;font-weight:600}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pill{font-size:11px;border:1px solid var(--ad-line);border-radius:20px;padding:3px 9px;color:var(--ad-muted);white-space:nowrap}.live{color:var(--ad-good)}.layout{display:grid;grid-template-columns:252px minmax(0,1fr);min-height:480px}.sidebar{background:color-mix(in srgb,var(--ad-surface) 45%,transparent);border-right:1px solid var(--ad-line);padding:12px}.side-label{font-size:11px;color:var(--ad-muted);padding:10px 10px 14px;text-transform:uppercase;letter-spacing:.07em}.provider{display:flex;align-items:center;border:1px solid transparent;border-radius:11px;margin:3px 0;padding:5px;gap:3px}.provider.selected{background:var(--ad-surface);border-color:var(--ad-line)}.provider button.select{display:flex;gap:12px;align-items:center;flex:1;min-width:0;text-align:left;border:0;padding:10px 6px}.avatar{width:32px;height:32px;flex-shrink:0;display:grid;place-items:center;font-size:13px;font-weight:650;color:var(--ad-accent);background:var(--ad-field);border-radius:9px}.avatar img{width:24px;height:24px;object-fit:contain}.provider-copy{min-width:0}.provider-copy strong{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.provider-copy small{font-size:11px;color:var(--ad-muted);display:block}.switch{width:32px;height:19px;flex:0 0 32px;padding:2px!important;border:0;border-radius:18px;background:var(--ad-line);position:relative}.switch:before{content:"";width:15px;height:15px;display:block;border-radius:50%;background:var(--ad-muted)}.switch[aria-checked=true]{background:var(--ad-accent)}.switch[aria-checked=true]:before{background:var(--ad-bg);margin-left:13px}.detail{padding:26px 30px;min-width:0}.detail-head{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:20px}.detail-head>div{min-width:0;overflow-wrap:anywhere}.detail-head h3{font-size:19px;margin:0;font-weight:600}.muted{color:var(--ad-muted)}.small{font-size:12px}.tabs{display:flex;gap:4px;border-bottom:1px solid var(--ad-line);margin:22px 0}.tabs button{border:0;border-radius:0;padding:10px 16px;color:var(--ad-muted);border-bottom:2px solid transparent}.tabs button[aria-selected=true]{color:var(--ad-accent);border-bottom-color:var(--ad-accent)}.group{border:1px solid var(--ad-line);border-radius:12px;overflow:hidden;margin:14px 0}.field{display:grid;grid-template-columns:minmax(130px,1fr) minmax(160px,1fr);gap:20px;padding:16px 18px;align-items:center}.field+.field{border-top:1px solid var(--ad-line)}.field label{font-weight:550;display:block}.hint{color:var(--ad-muted);font-size:12px;font-weight:400;margin:4px 0 0}input,select,textarea{border:1px solid var(--ad-line);border-radius:8px;padding:8px 10px;background:var(--ad-field);color:var(--ad-fg);width:100%;min-width:0}input:disabled{opacity:.65}input[type=checkbox]{width:16px;height:16px;accent-color:var(--ad-accent)}textarea{resize:vertical;min-height:90px}.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.model-access{flex-wrap:wrap}.model-access .inline{white-space:nowrap}.model-toolbar{margin-bottom:12px;display:flex;gap:14px;align-items:center}.model-toolbar input{max-width:260px}.models{border-top:1px solid var(--ad-line);margin-top:14px}.model{display:flex;align-items:center;gap:8px;padding:11px 0;border-bottom:1px solid var(--ad-line)}.model.hidden-model{opacity:.65}.model .model-name{flex:1;min-width:0;text-align:left;border:0;font:12px/1.5 ui-monospace,monospace;overflow-wrap:anywhere;padding:4px}.model .star{font-size:18px;width:27px;padding:2px;border:0}.star.favorite{color:#e9c979}.icon-button{font-size:12px;padding:3px 6px}.section-label{font-size:12px;color:var(--ad-muted);margin:22px 0 10px}.notice{border:1px solid var(--ad-line);border-radius:10px;padding:12px 15px;color:var(--ad-muted);font-size:12px;margin:12px 0}.error{border-color:#b5727c;color:#f2b7bf;margin:16px 24px}.success{color:var(--ad-good)}.empty{max-width:840px;margin:auto;padding:40px 32px}.empty h3{font-size:28px;line-height:1.25;letter-spacing:-.035em;margin:10px 0}.empty p{max-width:570px;color:var(--ad-muted)}.setup-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:26px}.setup-card{background:var(--ad-surface);border:1px solid var(--ad-line);border-radius:12px;padding:22px}.setup-card h4{font-size:15px;margin:4px 0 10px}.step{font-size:11px;color:var(--ad-accent);font-weight:600}.command{font:12px/1.6 ui-monospace,monospace;background:var(--ad-field);border-radius:8px;padding:12px;margin:14px 0;white-space:pre-wrap;overflow-wrap:anywhere}.connect-form{margin:24px 0}.connect-form label{display:block;margin-bottom:8px;font-weight:550}.connect-form textarea{font:12px/1.6 ui-monospace,monospace}.footer{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-top:18px}.inline{display:flex;align-items:center;gap:8px}.host-label{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.links{margin-top:24px;padding-top:18px;border-top:1px solid var(--ad-line)}.connections{padding:10px 0;border-bottom:1px solid var(--ad-line);display:flex;justify-content:space-between;gap:16px}.connection-meta{font-size:11px;color:var(--ad-muted);overflow-wrap:anywhere}.new-provider{border:1px dashed var(--ad-line);width:100%;margin-top:15px;text-align:left}.save-row{justify-content:flex-end}.loading{padding:50px;text-align:center;color:var(--ad-muted)}
.setup-host{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;border:1px solid var(--ad-line);border-radius:10px;padding:12px 16px;margin-bottom:22px;overflow-wrap:anywhere}.setup-host .hint{flex-basis:100%}.setup-host .small{overflow-wrap:anywhere;min-width:0}.provider-catalog{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:18px 0}.provider-choice,.method-choice{display:flex;flex-direction:column;align-items:flex-start;gap:5px;text-align:left;padding:16px}.provider-choice strong{font-size:15px}.provider-choice .hint{margin-top:auto;padding-top:8px}.method-list{display:grid;gap:10px;margin:18px 0}.method-choice.chosen{border-color:var(--ad-accent);background:var(--ad-surface)}.method-choice strong:before{content:"○";margin-right:8px;color:var(--ad-muted)}.method-choice.chosen strong:before{content:"●";color:var(--ad-accent)}.setup-title h4{font-size:20px;margin:3px 0}.advanced summary{cursor:pointer;color:var(--ad-muted);padding:8px 0}.advanced .group{margin-top:6px}.hint a{color:var(--ad-accent);white-space:normal}
@media(max-width:760px){.provider-catalog{grid-template-columns:1fr}.setup-title{flex-wrap:wrap}.top{padding:18px;align-items:flex-start;flex-wrap:wrap}.layout{grid-template-columns:1fr}.sidebar{border-right:0;border-bottom:1px solid var(--ad-line);display:flex;gap:6px;overflow:auto;align-items:center}.side-label{display:none}.provider{flex:0 0 205px}.new-provider{width:auto;white-space:nowrap;margin:0}.detail{padding:22px 18px}.field{grid-template-columns:1fr;gap:9px;padding:14px}.setup-grid{grid-template-columns:1fr}.empty{padding:26px 20px}.empty h3{font-size:25px}.host-label{max-width:180px}.model{gap:3px}.model-toolbar{align-items:flex-start;flex-wrap:wrap}.model .model-name{font-size:11px}.footer{flex-wrap:wrap}}
`;
export function registerProviderPanel(registry = customElements) {
    if (registry.get("agenticdriver-providers"))
        return;
    class Panel extends HTMLElement {
        transport;
        root = this.attachShadow({ mode: "open" });
        state;
        selected = "";
        tab = "runtime";
        query = "";
        busy = false;
        message = "";
        failure = "";
        adding = false;
        removalPending = false;
        stylesInstalled = false;
        providerQuery = "";
        setupMethod = "";
        setupTimer;
        setupSequence = 0;
        draft;
        apiKey = "";
        generation = 0;
        bound = false;
        pendingFocus;
        links;
        invite;
        preferenceScope = crypto.randomUUID();
        preferenceCache = new Map();
        connectedCallback() {
            if (!this.stylesInstalled) {
                // The module is authorized by script-src. Constructed stylesheets keep
                // the component self-contained without inline style elements/attributes.
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(css);
                this.root.adoptedStyleSheets = [sheet];
                this.stylesInstalled = true;
            }
            if (!this.transport && this.hasAttribute("api"))
                this.transport = createPanelTransport(this.getAttribute("api"));
            if (!this.bound) {
                this.bound = true;
                this.root.addEventListener("click", (event) => {
                    void this.onClick(event).catch((error) => this.fail(error));
                });
                this.root.addEventListener("input", (event) => this.input(event));
                this.root.addEventListener("change", (event) => this.change(event));
                this.root.addEventListener("keydown", (event) => {
                    if (!(event instanceof KeyboardEvent) || this.busy)
                        return;
                    const target = event.target;
                    if (target.getAttribute("role") !== "tab")
                        return;
                    const tabs = [
                        ...this.root.querySelectorAll('[role="tab"]'),
                    ];
                    const index = tabs.indexOf(target);
                    const next = event.key === "ArrowRight"
                        ? (index + 1) % tabs.length
                        : event.key === "ArrowLeft"
                            ? (index + tabs.length - 1) % tabs.length
                            : event.key === "Home"
                                ? 0
                                : event.key === "End"
                                    ? tabs.length - 1
                                    : -1;
                    if (next < 0)
                        return;
                    event.preventDefault();
                    const tab = tabs[next];
                    tab.click();
                    this.root
                        .querySelector(`[data-tab="${tab.dataset.tab}"]`)
                        ?.focus();
                });
            }
            void this.refresh();
        }
        disconnectedCallback() {
            this.generation++;
            clearTimeout(this.setupTimer);
            this.setupSequence++;
        }
        async call(request) {
            if (!this.transport)
                throw new Error("Connect this component to your application's provider panel backend.");
            return this.transport(request);
        }
        fail(error) {
            this.failure =
                error instanceof Error ? error.message : "The request failed.";
            this.busy = false;
            this.render();
        }
        accept(value) {
            const state = value;
            if (typeof state?.connected !== "boolean" ||
                !Array.isArray(state.providers))
                throw new Error("The panel returned invalid connection state.");
            this.state = state;
            this.failure = state.connectionError ?? "";
            if (!state.providers.some((p) => p.id === this.selected))
                this.selected = state.providers[0]?.id ?? "";
            this.draft = structuredClone(state.management?.providers.find((p) => p.id === this.selected));
            this.adding = false;
            this.removalPending = false;
            this.apiKey = "";
            this.links = undefined;
            this.invite = undefined;
            this.armSetupPoll();
        }
        async setupRequest(request) {
            const generation = this.generation;
            const sequence = ++this.setupSequence;
            this.busy = true;
            clearTimeout(this.setupTimer);
            this.render();
            try {
                const result = (await this.call({
                    action: "setup",
                    request,
                }));
                if (generation !== this.generation ||
                    sequence !== this.setupSequence ||
                    !this.state)
                    return;
                if (request.action === "accept" &&
                    result.attempts[0]?.phase === "succeeded") {
                    const snapshot = await this.call({ action: "snapshot" });
                    if (generation === this.generation &&
                        sequence === this.setupSequence) {
                        this.selected = result.attempts[0].providerId;
                        this.accept(snapshot);
                        this.message =
                            "Account connected. Application execution grants stay unchanged.";
                    }
                }
                else {
                    const changed = new Set(result.attempts.map((a) => a.id));
                    this.state.setup = {
                        version: 1,
                        attempts: [
                            ...(this.state.setup?.attempts ?? []).filter((a) => !changed.has(a.id)),
                            ...result.attempts,
                        ],
                    };
                    if (request.action === "start") {
                        this.adding = false;
                        this.apiKey = "";
                        this.draft = structuredClone(this.state.management?.providers.find((p) => p.id === this.selected));
                    }
                }
            }
            finally {
                if (generation === this.generation) {
                    this.busy = false;
                    this.render();
                    this.armSetupPoll();
                }
            }
        }
        armSetupPoll() {
            clearTimeout(this.setupTimer);
            if (!this.isConnected ||
                !this.state?.setup?.attempts.some((a) => ["starting", "waiting", "verifying", "ready"].includes(a.phase)))
                return;
            this.setupTimer = setTimeout(async () => {
                if (this.busy) {
                    this.armSetupPoll();
                    return;
                }
                const generation = this.generation, sequence = ++this.setupSequence;
                try {
                    const result = (await this.call({
                        action: "setup",
                        request: { action: "list" },
                    }));
                    if (generation !== this.generation ||
                        sequence !== this.setupSequence ||
                        !this.state)
                        return;
                    if (JSON.stringify(result) !== JSON.stringify(this.state.setup)) {
                        this.state.setup = result;
                        this.render();
                    }
                    this.armSetupPoll();
                }
                catch (error) {
                    if (generation === this.generation &&
                        sequence === this.setupSequence) {
                        this.failure =
                            "Sign-in status is unavailable. Refresh to reconnect. " +
                                (error instanceof Error ? error.message : "");
                        this.render();
                    }
                }
            }, 2000);
        }
        async refresh() {
            const generation = ++this.generation;
            clearTimeout(this.setupTimer);
            this.setupSequence++;
            this.busy = true;
            this.failure = "";
            this.render();
            try {
                const state = await this.call({ action: "snapshot", refresh: true });
                if (generation === this.generation)
                    this.accept(state);
            }
            catch (error) {
                if (generation === this.generation)
                    this.failure =
                        error instanceof Error ? error.message : "Could not connect.";
            }
            finally {
                if (generation === this.generation) {
                    this.busy = false;
                    this.render();
                }
            }
        }
        preferences() {
            const key = `agenticdriver.models.${this.state?.connection?.id ?? this.preferenceScope}.${this.selected}`;
            if (!this.preferenceCache.has(key)) {
                let value = emptyPreferences();
                try {
                    const stored = JSON.parse(localStorage.getItem(key) ?? "null");
                    if (stored &&
                        ["favorites", "hidden", "order"].every((k) => Array.isArray(stored[k]) &&
                            stored[k].length <= 1000 &&
                            stored[k].every((v) => typeof v === "string")))
                        value = stored;
                }
                catch {
                    /* Private browsing or unavailable storage: use in-memory preferences. */
                }
                this.preferenceCache.set(key, value);
            }
            return this.preferenceCache.get(key);
        }
        savePreferences(value) {
            const key = `agenticdriver.models.${this.state?.connection?.id ?? this.preferenceScope}.${this.selected}`;
            this.preferenceCache.set(key, value);
            try {
                localStorage.setItem(key, JSON.stringify(value));
            }
            catch {
                /* In-memory preferences remain usable. */
            }
            this.dispatchEvent(new CustomEvent("agenticdriver:preferences-changed", {
                detail: { provider: this.selected, ...value },
                bubbles: true,
                composed: true,
            }));
            this.render();
        }
        models(provider) {
            const all = [
                ...new Set([
                    ...(provider?.modelCatalog?.models ?? []),
                    ...(this.draft?.models ?? provider?.models ?? []),
                ]),
            ];
            const prefs = this.preferences();
            return all.sort((a, b) => Number(prefs.favorites.includes(b)) -
                Number(prefs.favorites.includes(a)) ||
                (prefs.order.indexOf(a) < 0 ? 1001 : prefs.order.indexOf(a)) -
                    (prefs.order.indexOf(b) < 0 ? 1001 : prefs.order.indexOf(b)) ||
                a.localeCompare(b));
        }
        async save(provider, includeApiKey = false) {
            const revision = this.state?.management?.revision;
            if (!revision)
                throw new Error("Management access is required to edit host settings.");
            this.busy = true;
            this.failure = "";
            this.render();
            const change = {
                revision,
                provider,
                ...(includeApiKey && this.apiKey ? { apiKey: this.apiKey } : {}),
            };
            try {
                this.accept(await this.call({ action: "configure", change }));
                this.selected = provider.id;
                this.draft = structuredClone(this.state?.management?.providers.find((p) => p.id === provider.id));
                this.message =
                    "Settings saved. Active runs continue with their original settings.";
            }
            finally {
                this.apiKey = "";
                this.busy = false;
                this.render();
            }
        }
        async removeProvider() {
            const management = this.state?.management;
            const provider = management?.providers.find((p) => p.id === this.selected);
            if (!this.removalPending ||
                !management?.removalSupported ||
                !provider ||
                provider.kind === "extension")
                throw new Error("This connection cannot remove the selected provider.");
            this.busy = true;
            this.render();
            try {
                this.accept(await this.call({
                    action: "configure",
                    change: {
                        revision: management.revision,
                        provider,
                        remove: true,
                    },
                }));
                this.message =
                    "Provider removed. Active runs keep their original settings; credentials remain on the host.";
            }
            finally {
                this.busy = false;
                this.render();
            }
        }
        input(event) {
            const input = event.target;
            if (input.dataset.field === "provider-query") {
                this.providerQuery = input.value;
                this.render();
                return;
            }
            if (input.dataset.field === "query") {
                this.query = input.value;
                this.render();
                return;
            }
            if (input.dataset.field === "apiKey") {
                this.apiKey = input.value;
                return;
            }
            if (!this.draft || !input.dataset.config)
                return;
            const config = this.draft;
            if (input.dataset.config === "env")
                config.apiKeyRef = { env: input.value };
            else if (input.dataset.config === "file")
                config.apiKeyRef = { file: input.value };
            else if (input.value)
                config[input.dataset.config] = input.value;
            else
                delete config[input.dataset.config];
        }
        change(event) {
            const target = event.target;
            if (target.dataset.field === "kind") {
                const kind = target.value, id = this.draft?.id ?? "";
                this.draft = {
                    id,
                    kind,
                    ...(native(kind) || kind === "mock"
                        ? {}
                        : { apiKeyRef: { env: keyEnv[kind] ?? "PROVIDER_API_KEY" } }),
                };
                this.apiKey = "";
                this.render();
            }
            if (target.dataset.field === "reference-kind" &&
                this.draft &&
                "apiKeyRef" in this.draft) {
                this.draft.apiKeyRef =
                    target.value === "file"
                        ? { file: "" }
                        : { env: keyEnv[this.draft.kind] ?? "PROVIDER_API_KEY" };
                this.render();
            }
            if (target.dataset.field === "setup-kind") {
                const command = this.root.querySelector(".command");
                if (command)
                    command.textContent = `agenticdriver setup --provider ${target.value} --manage`;
            }
        }
        async onClick(event) {
            const button = event.target.closest("button[data-action]");
            if (!button || button.disabled || this.busy)
                return;
            const action = button.dataset.action, model = button.dataset.model;
            this.failure = "";
            this.message = "";
            if (action === "refresh")
                return this.refresh();
            if (action === "remove-provider") {
                this.removalPending = true;
                this.render();
                this.root
                    .querySelector('[data-action="cancel-remove"]')
                    ?.focus();
                return;
            }
            if (action === "cancel-remove") {
                this.removalPending = false;
                this.render();
                this.root
                    .querySelector('[data-action="remove-provider"]')
                    ?.focus();
                return;
            }
            if (action === "confirm-remove")
                return this.removeProvider();
            if ((action === "setup-accept" || action === "setup-cancel") &&
                button.dataset.id) {
                return this.setupRequest({
                    action: action === "setup-accept" ? "accept" : "cancel",
                    id: button.dataset.id,
                });
            }
            if (action === "select") {
                this.removalPending = false;
                this.selected = button.dataset.id;
                this.query = "";
                this.adding = false;
                this.apiKey = "";
                this.draft = structuredClone(this.state?.management?.providers.find((p) => p.id === this.selected));
                this.render();
                return;
            }
            if (action === "tab") {
                this.tab = button.dataset.tab;
                this.render();
                return;
            }
            if (action === "add") {
                this.removalPending = false;
                this.adding = true;
                this.draft = this.state?.management?.providerDefinitions
                    ? undefined
                    : { id: "", kind: "codex" };
                this.apiKey = "";
                this.setupMethod = "";
                this.providerQuery = "";
                this.tab = "runtime";
                this.render();
                return;
            }
            if (action === "pick-provider") {
                const definition = this.definitions().find((p) => p.kind === button.dataset.kind);
                if (!definition)
                    return;
                const taken = new Set([
                    ...(this.state?.management?.providers.map((p) => p.id) ?? []),
                    ...(this.state?.setup?.attempts
                        .filter((a) => ["starting", "waiting", "verifying", "ready"].includes(a.phase))
                        .map((a) => a.providerId) ?? []),
                ]);
                let id = definition.kind, suffix = 2;
                while (taken.has(id))
                    id = `${definition.kind}-${suffix++}`;
                this.draft = {
                    id,
                    kind: definition.kind,
                    name: definition.name,
                    ...(native(definition.kind) || definition.kind === "mock"
                        ? {}
                        : {
                            apiKeyRef: {
                                env: keyEnv[definition.kind] ?? "PROVIDER_API_KEY",
                            },
                        }),
                };
                this.setupMethod =
                    definition.methods.find((m) => setupInteractions.has(m.interaction))
                        ?.id ?? "";
                this.apiKey = "";
                this.render();
                this.root
                    .querySelector("[data-field=method-heading]")
                    ?.focus();
                return;
            }
            if (action === "setup-method") {
                this.setupMethod = button.dataset.method;
                if (this.setupMethod === "api-key" &&
                    this.draft &&
                    "apiKeyRef" in this.draft)
                    this.draft.apiKeyRef = {
                        env: keyEnv[this.draft.kind] ?? "PROVIDER_API_KEY",
                    };
                this.apiKey = "";
                this.render();
                return;
            }
            if (action === "back-providers") {
                this.draft = undefined;
                this.apiKey = "";
                this.setupMethod = "";
                this.render();
                this.root
                    .querySelector("[data-field=provider-query]")
                    ?.focus();
                return;
            }
            if (action === "cancel-add") {
                this.adding = false;
                this.apiKey = "";
                this.draft = structuredClone(this.state?.management?.providers.find((p) => p.id === this.selected));
                this.render();
                return;
            }
            if (action === "connect-provider" && this.draft) {
                const method = this.definitions()
                    .find((d) => d.kind === this.draft?.kind)
                    ?.methods.find((m) => m.id === this.setupMethod);
                if (!method || !setupInteractions.has(method.interaction))
                    throw new Error("Choose a supported connection method.");
                if (method.interaction === "device-code") {
                    if (!this.state?.setup ||
                        !this.state.management ||
                        this.draft.kind !== "codex" ||
                        method.id !== "codex-device")
                        throw new Error("This host does not offer that sign-in method.");
                    const { accountDirectory: _shared, ...provider } = this.draft;
                    return this.setupRequest({
                        action: "start",
                        revision: this.state.management.revision,
                        method: "codex-device",
                        provider: {
                            ...provider,
                            accountId: provider.accountId || `account-${crypto.randomUUID()}`,
                        },
                    });
                }
                if (method.interaction === "api-key" && !this.apiKey.trim())
                    throw new Error("Enter an API key, or choose a host credential reference.");
                if (this.draft.kind === "openai-compatible" && !this.draft.baseUrl)
                    throw new Error("Enter the compatible endpoint URL.");
                return this.save(this.draft, true);
            }
            if (action === "save" && this.draft)
                return this.save(this.draft, true);
            if (action === "enable") {
                const p = this.state?.management?.providers.find((p) => p.id === button.dataset.id);
                if (p)
                    return this.save({ ...p, enabled: p.enabled === false });
            }
            if (action === "allow-all" && this.draft) {
                const p = { ...this.draft };
                if (p.models === undefined)
                    p.models = this.models(this.state?.providers.find((p) => p.id === this.selected));
                else
                    delete p.models;
                return this.save(p);
            }
            if (action === "access" && this.draft && model) {
                const models = this.draft.models ??
                    this.models(this.state?.providers.find((p) => p.id === this.selected));
                return this.save({
                    ...this.draft,
                    models: models.includes(model)
                        ? models.filter((m) => m !== model)
                        : [...models, model],
                });
            }
            if (action === "custom" && this.draft) {
                const input = this.root.querySelector("[data-field=custom]");
                const model = input.value.trim();
                if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/.test(model))
                    throw new Error("Enter a valid explicit model ID.");
                return this.save({
                    ...this.draft,
                    models: [
                        ...new Set([
                            ...(this.draft.models ??
                                this.models(this.state?.providers.find((p) => p.id === this.selected))),
                            model,
                        ]),
                    ],
                });
            }
            if (action === "choose" && model) {
                this.dispatchEvent(new CustomEvent("agenticdriver:model-selected", {
                    detail: { provider: this.selected, model },
                    bubbles: true,
                    composed: true,
                }));
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
                }
                else {
                    const order = this.models(this.state?.providers.find((p) => p.id === this.selected));
                    const i = order.indexOf(model), next = i + (action === "up" ? -1 : 1);
                    if (i >= 0 && next >= 0 && next < order.length)
                        [order[i], order[next]] = [order[next], order[i]];
                    prefs.order = order;
                }
                this.savePreferences(prefs);
                return;
            }
            if (action === "connect") {
                const invitation = this.root
                    .querySelector("[data-field=invitation]")
                    ?.value.trim() ?? "";
                if (!invitation)
                    throw new Error("Paste an invitation from the host you want to connect.");
                this.busy = true;
                this.render();
                try {
                    this.accept(await this.call({ action: "connect", invitation }));
                }
                finally {
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
                }
                finally {
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
                    }));
                }
                finally {
                    this.busy = false;
                    this.render();
                }
                return;
            }
            if (action === "revoke") {
                this.busy = true;
                this.render();
                try {
                    await this.call({ action: "revoke", id: button.dataset.id });
                    this.links = (await this.call({
                        action: "connections",
                    }));
                }
                finally {
                    this.busy = false;
                    this.render();
                }
                return;
            }
            if (action === "invite") {
                const subject = this.root
                    .querySelector("[data-field=subject]")
                    ?.value.trim() || "connected-app";
                this.busy = true;
                this.render();
                try {
                    this.invite = (await this.call({
                        action: "invite",
                        subject,
                        providers: this.state?.providers.map((p) => p.id) ?? [],
                        manageProviders: false,
                    }));
                }
                finally {
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
        avatar(provider) {
            const presentation = this.state?.presentations?.[provider.id];
            if (presentation?.icon.kind === "asset") {
                try {
                    const path = assetPath(presentation.icon.asset.src);
                    return `<span class="avatar"><img src="${escape(path)}" alt="${escape(presentation.icon.alt)}"></span>`;
                }
                catch {
                    /* Fall back to initials if an asset is not local. */
                }
            }
            return `<span class="avatar" aria-hidden="true">${escape(presentation?.icon.kind === "fallback" ? presentation.icon.text : provider.name.slice(0, 2).toUpperCase())}</span>`;
        }
        field(label, key, value, hint = "", disabled = false, password = false) {
            return `<div class="field"><div><label for="field-${key}">${escape(label)}</label>${hint ? `<p class="hint">${escape(hint)}</p>` : ""}</div><input id="field-${key}" ${key === "apiKey" ? 'data-field="apiKey"' : `data-config="${key}"`} value="${escape(value)}" ${password ? 'type="password" autocomplete="new-password"' : 'autocomplete="off" spellcheck="false"'} ${disabled ? "disabled" : ""}></div>`;
        }
        disconnected() {
            return `<div class="empty"><div class="eyebrow">YOUR AGENTS. YOUR ACCOUNTS.</div><h3>Connect your AgenticDriver.</h3><p>Use the providers already signed in on your computer, or connect an execution host on another machine.</p><div class="setup-grid"><section class="setup-card"><span class="step">01 / START A LOCAL HOST</span><h4>Use this computer</h4><label class="small muted" for="setup-kind">Provider</label><select id="setup-kind" data-field="setup-kind">${Object.entries(labels)
                .filter(([k]) => k !== "openai-compatible")
                .map(([k, v]) => `<option value="${k}">${v}</option>`)
                .join("")}</select><pre class="command">agenticdriver setup --provider codex --manage</pre><p class="small">Run this in a terminal on the provider machine. Keep it running and copy the invitation it prints.</p></section><section class="setup-card"><span class="step">02 / OR USE A REMOTE HOST</span><h4>Connect another machine</h4><p class="small">Ask its operator for an AgenticDriver invitation. The invitation includes the host address and your connection permissions.</p><div class="notice">Remote hosts use HTTPS. For hosted apps, the address must be reachable from the app's backend.</div><p class="small">Already running a host? Create an invitation with <code>agenticdriver pair</code>.</p></section></div><div class="connect-form">${this.state?.connection && this.state.canDisconnect ? '<div class="notice">A saved connection is unavailable. <button data-action="disconnect">Forget saved connection</button></div>' : ""}<label for="invitation">Connection invitation</label><textarea id="invitation" data-field="invitation" placeholder="ad1.…" autocomplete="off" spellcheck="false" aria-describedby="invite-hint"></textarea><div class="footer"><span class="hint" id="invite-hint">Used once. Your app keeps the connection credential privately.</span><button class="primary" data-action="connect" ${this.busy || this.state?.canConnect === false ? "disabled" : ""}>${this.busy ? "Connecting…" : "Connect host →"}</button></div>${this.state?.canConnect === false ? '<p class="hint">This application manages connections outside this panel.</p>' : ""}</div></div>`;
        }
        definitions() {
            const management = this.state?.management;
            return (management?.providerDefinitions ?? [])
                .filter((p) => management?.supportedKinds.includes(p.kind))
                .map((p) => ({
                ...p,
                methods: p.methods.filter((m) => m.interaction !== "device-code" ||
                    (Boolean(this.state?.setup) &&
                        m.id === "codex-device" &&
                        p.kind === "codex")),
            }));
        }
        setupCards() {
            const attempts = this.state?.setup?.attempts ?? [];
            const pending = attempts.filter((a) => ["starting", "waiting", "verifying", "ready"].includes(a.phase));
            const finished = attempts.filter((a) => !pending.includes(a)).slice(-2);
            if (!attempts.length)
                return "";
            const statuses = {
                starting: "Starting sign-in…",
                waiting: "Complete sign-in in your browser",
                verifying: "Verifying the account…",
                ready: "Confirm this account",
                succeeded: "Account connected",
                failed: "Sign-in failed",
                cancelled: "Sign-in cancelled",
                expired: "Sign-in expired",
            };
            return `<section class="setup-attempts" aria-label="Provider sign-in">${[
                ...pending,
                ...finished,
            ]
                .map((a) => {
                const active = pending.includes(a);
                const device = a.phase === "waiting" &&
                    a.interaction?.verificationUrl ===
                        "https://auth.openai.com/codex/device"
                    ? a.interaction
                    : undefined;
                return `<article class="setup-card"><div class="eyebrow">${escape(a.name)} · ${escape(this.state?.connection?.label ?? "Connected host")}</div><h4>${escape(statuses[a.phase] ?? a.phase)}</h4>${device ? `<p>Open the official ChatGPT page and enter this code:</p><pre class="command" aria-label="Device sign-in code">${escape(device.userCode)}</pre><a href="https://auth.openai.com/codex/device" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open ChatGPT sign-in ↗</a><p class="hint">Sign in only if you started this connection. Return here to confirm the verified account.</p>` : ""}${a.phase === "ready" && a.account ? `<p><strong>${escape(a.account.email ?? "ChatGPT account")}</strong> · ${escape(a.account.plan)}</p>${a.account.providerAccountId ? `<p class="hint">Provider account: ${escape(a.account.providerAccountId)}</p>` : ""}<p>Connect this account as <strong>${escape(a.name)}</strong> on ${escape(this.state?.connection?.label ?? "this host")}?</p><button class="primary" data-action="setup-accept" data-id="${escape(a.id)}" ${this.busy ? "disabled" : ""}>Confirm account</button>` : ""}${a.error ? `<p class="notice error" role="alert">${escape(a.error.message)}</p>` : ""}${active ? `<div class="footer"><span class="hint">Sign-in expires ${escape(new Date(a.expiresAt).toLocaleTimeString())} · Existing accounts stay connected.</span><button data-action="setup-cancel" data-id="${escape(a.id)}" ${this.busy ? "disabled" : ""}>Cancel sign-in</button></div>` : `<p class="hint">${a.phase === "succeeded" ? "Account verified. No model was run and application permissions stay unchanged." : "You can start a new attempt from Add provider."}</p>`}</article>`;
            })
                .join("")}</section>`;
        }
        setupProvider() {
            const definitions = this.definitions(), p = this.draft;
            const host = `<div class="setup-host"><span class="eyebrow">SET UP ON</span><strong>${escape(this.state?.connection?.label ?? "Connected host")}</strong>${this.state?.connection?.url ? `<span class="small muted">${escape(this.state.connection.url)}</span>` : ""}<span class="hint">Accounts, paths and credentials belong to this host.</span></div>`;
            if (!p) {
                const filtered = definitions.filter((d) => `${d.name} ${d.description} ${d.kind} ${d.category} ${d.protocol}`
                    .toLowerCase()
                    .includes(this.providerQuery.toLowerCase()));
                return `${host}<label class="section-label" for="provider-search">Choose a provider connection</label><input id="provider-search" data-field="provider-query" type="search" placeholder="Search providers, APIs or gateways…" value="${escape(this.providerQuery)}"><div class="provider-catalog">${filtered.map((d) => `<button class="provider-choice" data-action="pick-provider" data-kind="${escape(d.kind)}" ${!Object.hasOwn(labels, d.kind) ? "disabled" : ""}><span class="eyebrow">${escape(categories[d.category] ?? d.category)}</span><strong>${escape(d.name)}</strong><span class="small muted">${escape(d.description)}</span><span class="hint">${Object.hasOwn(labels, d.kind) ? escape(d.protocol) : "Requires a newer panel"}</span></button>`).join("") || '<p class="muted">No supported provider connections match this search.</p>'}</div><div class="footer"><span class="hint">Choose a connection method next. No model calls are made.</span><button data-action="cancel-add">Cancel</button></div>`;
            }
            const definition = definitions.find((d) => d.kind === p.kind);
            if (!definition)
                return '<div class="notice">This provider is no longer advertised by the host. Refresh to load current setup options.</div>';
            const method = definition.methods.find((m) => m.id === this.setupMethod);
            const methods = definition.methods
                .map((m) => `<button class="method-choice ${m.id === this.setupMethod ? "chosen" : ""}" data-action="setup-method" data-method="${escape(m.id)}" aria-pressed="${m.id === this.setupMethod}" ${!setupInteractions.has(m.interaction) ? "disabled" : ""}><strong>${escape(m.label)}</strong><span class="small muted">${escape(m.description)}</span>${!setupInteractions.has(m.interaction) ? '<span class="hint">Requires a newer panel</span>' : ""}</button>`)
                .join("");
            let fields = this.field("Connection name", "name", p.name, "A recognizable name for this account or gateway.");
            let advanced = this.field("Instance ID", "id", p.id, "Unique on this host. Use a new ID for a different account.") +
                this.field("Account ID", "accountId", p.accountId, method?.interaction === "device-code"
                    ? "A stable account ID is created if left empty."
                    : "Optional stable identity for usage tracking.");
            if (native(p.kind)) {
                advanced += this.field("Binary path", "binary", "binary" in p ? p.binary : undefined, "Official runtime executable on this host. Empty uses its standard command.");
                if (method?.interaction !== "device-code")
                    advanced += this.field("Account directory", "accountDirectory", "accountDirectory" in p ? p.accountDirectory : undefined, "Absolute path to the signed-in account on this host.");
                if (p.kind === "codex")
                    advanced += this.field("Reasoning effort", "reasoningEffort", p.reasoningEffort, "Optional. Supported values depend on the selected model.");
            }
            if ("apiKeyRef" in p) {
                if (p.kind === "openai-compatible")
                    fields += this.field("API endpoint", "baseUrl", p.baseUrl, "Required. The endpoint must support OpenAI Chat Completions.");
                else
                    advanced += this.field("API endpoint", "baseUrl", p.baseUrl, `Optional endpoint override for ${definition.protocol}.`);
                if (method?.interaction === "api-key")
                    fields += this.field("API key", "apiKey", this.apiKey, "Write only. Stored privately on the connected host when you save.", false, true);
                if (method?.interaction === "secret-reference") {
                    const file = "file" in p.apiKeyRef;
                    fields += `<div class="field"><label for="reference-kind">Credential source</label><select id="reference-kind" data-field="reference-kind"><option value="env" ${!file ? "selected" : ""}>Host environment variable</option><option value="file" ${file ? "selected" : ""}>Private file on host</option></select></div>`;
                    fields += file
                        ? this.field("Credential file", "file", "file" in p.apiKeyRef ? p.apiKeyRef.file : "", "Enter a private file path on the connected host.")
                        : this.field("Credential environment variable", "env", "env" in p.apiKeyRef ? p.apiKeyRef.env : "", "Enter the variable name, not its secret value.");
                }
            }
            const owner = method?.credentialOwner === "native-runtime"
                ? "Credentials stay with the official runtime."
                : method?.credentialOwner === "host"
                    ? "Credentials are resolved privately by the connected host."
                    : "No credentials are needed.";
            return `${host}<div class="row setup-title"><div><span class="eyebrow">${escape(categories[definition.category])}</span><h4 tabindex="-1" data-field="method-heading">${escape(definition.name)}</h4><span class="hint">${escape(definition.protocol)}</span></div><button data-action="back-providers">Change provider</button></div><div class="method-list" aria-label="Connection methods">${methods}</div>${definition.requirements ? `<div class="notice">${escape(definition.requirements)}</div>` : ""}<p class="hint">${owner} ${helpLink(definition.docsUrl)}</p><div class="group">${fields}</div><details class="advanced"><summary>Advanced settings</summary><div class="group">${advanced}</div></details><div class="notice">All models are allowed by default for this instance. You can add connection overrides in Models. Application execution grants stay separate. ${method?.interaction === "device-code" ? "Sign-in verifies the account; models remain untested until you explicitly run them." : "Saving does not run a model or verify account access."}</div><div class="footer"><button data-action="cancel-add">Cancel</button><button class="primary" data-action="connect-provider" ${this.busy || !method || !setupInteractions.has(method.interaction) ? "disabled" : ""}>${this.busy ? "Saving…" : method?.interaction === "device-code" ? "Start sign-in" : "Save connection"}</button></div>`;
        }
        runtime(provider) {
            if (this.adding && this.state?.management?.providerDefinitions)
                return this.setupProvider();
            const p = this.draft, readonly = !this.state?.management || p?.kind === "extension";
            if (!p && !provider)
                return this.state?.management
                    ? '<div class="notice">You have management access to this host. Add a provider to get started.</div>'
                    : '<div class="notice">No providers are available to this connection. Ask the host operator to review its provider access.</div>';
            if (!p)
                return `<div class="notice">Provider settings are read-only for this connection. Management access is required to edit this host's provider settings.</div><div class="group">${this.field("Provider instance", "id", provider?.id, "", true)}${this.field("Connection mode", "mode", provider?.authMode, "", true)}</div>`;
            let fields = this.field("Display name", "name", p.name ?? "", "A label for this provider connection.", readonly);
            if (this.adding)
                fields += this.field("Instance ID", "id", p.id, "Unique on this host. Use a new ID for a different account.");
            fields += this.field("Account ID", "accountId", p.accountId, "Stable account identity used for usage tracking.", !this.adding);
            if (native(p.kind))
                fields +=
                    this.field("Binary path", "binary", "binary" in p ? p.binary : undefined, "Executable on the connected host. Empty uses its standard command.") +
                        this.field("Account directory", "accountDirectory", "accountDirectory" in p ? p.accountDirectory : undefined, "Use the provider's signed-in account directory on that host.");
            if (p.kind === "codex")
                fields += this.field("Reasoning effort", "reasoningEffort", p.reasoningEffort, "Optional. Supported values depend on the selected model.");
            if ("apiKeyRef" in p) {
                fields += this.field("API endpoint", "baseUrl", p.baseUrl, "Optional vendor endpoint. Compatible APIs require an explicit URL.");
                if ("env" in p.apiKeyRef)
                    fields += this.field("Credential environment variable", "env", p.apiKeyRef.env, "Read from the host environment.");
                else if ("file" in p.apiKeyRef)
                    fields += this.field("Credential file", "file", p.apiKeyRef.file, "Private file on the host. Its contents are never returned.");
                fields += this.field("Replace API key", "apiKey", this.apiKey, "Write only. Leave empty to keep the current credential.", false, true);
            }
            return `${this.adding ? `<label for="provider-kind" class="small muted">Provider type</label><select id="provider-kind" data-field="kind">${this.state?.management?.supportedKinds.map((k) => `<option value="${escape(k)}" ${p.kind === k ? "selected" : ""}>${escape(labels[k] ?? k)}</option>`).join("")}</select>` : ""}<div class="group">${fields}</div>${native(p.kind) ? '<p class="hint">Native sign-in and installation happen through the provider’s official runtime on the host.</p>' : ""}<div class="footer save-row"><button class="primary" data-action="save" ${this.busy || readonly ? "disabled" : ""}>${this.busy ? "Saving…" : "Save settings"}</button></div>`;
        }
        modelList(provider) {
            const models = this.models(provider), prefs = this.preferences(), p = this.draft;
            const unrestricted = (p ? p.models : provider?.models) === undefined, allowed = p?.models ?? provider?.models;
            const canManage = Boolean(this.state?.management && p && p.kind !== "extension");
            return `<div class="row model-access"><div><strong>Model access</strong><p class="hint">Reported models stay visible. Permissions apply to new runs.</p></div><label class="inline small"><span>Allow all models</span><button class="switch" role="switch" aria-label="Allow all models" aria-checked="${unrestricted}" data-action="allow-all" ${!canManage || this.busy ? "disabled" : ""}></button></label></div><div class="notice">${provider?.modelCatalog?.source === "provider" ? "Inventory reported by this provider. A listed model has not necessarily passed a live test." : "The provider has not supplied a model inventory. Configured IDs are shown without an availability claim."}</div><div class="model-toolbar"><input aria-label="Filter models" data-field="query" value="${escape(this.query)}" placeholder="Filter models…"><span class="small muted">${models.length} models · ${prefs.favorites.filter((m) => models.includes(m)).length} favorites</span></div><p class="hint">Stars, visibility and ordering are saved on this device. Access switches change the host provider settings.</p>${this.state?.management && !this.state.management.executionProviders?.includes(provider?.id ?? "") ? '<p class="hint">This connection has management access. Execution access to this provider is not granted or has not been reported by the host.</p>' : ""}<div class="models">${models
                .filter((m) => m.toLowerCase().includes(this.query.toLowerCase()))
                .map((model) => {
                const enabled = unrestricted || allowed?.includes(model);
                const canSelect = !this.state?.management ||
                    this.state.management.executionProviders?.includes(provider?.id ?? "") === true;
                return `<div class="model ${prefs.hidden.includes(model) ? "hidden-model" : ""}"><button class="star ${prefs.favorites.includes(model) ? "favorite" : ""}" data-action="favorite" data-model="${escape(model)}" aria-label="Favorite ${escape(model)}" aria-pressed="${prefs.favorites.includes(model)}">${prefs.favorites.includes(model) ? "★" : "☆"}</button><button class="model-name" data-action="choose" data-model="${escape(model)}" ${!enabled || !canSelect || p?.enabled === false ? "disabled" : ""}>${escape(model)}</button><button class="quiet icon-button" data-action="visibility" data-model="${escape(model)}" aria-label="${prefs.hidden.includes(model) ? "Show" : "Hide"} ${escape(model)}">${prefs.hidden.includes(model) ? "Show" : "Hide"}</button><button class="quiet icon-button" data-action="up" data-model="${escape(model)}" aria-label="Move ${escape(model)} up">↑</button><button class="quiet icon-button" data-action="down" data-model="${escape(model)}" aria-label="Move ${escape(model)} down">↓</button><button class="switch" role="switch" aria-label="Allow ${escape(model)}" aria-checked="${Boolean(enabled)}" data-action="access" data-model="${escape(model)}" ${!canManage || this.busy ? "disabled" : ""}></button></div>`;
            })
                .join("") ||
                '<p class="muted small">No models match this view. Refresh the provider or configure an explicit model ID.</p>'}</div>${canManage ? '<div class="section-label">Add an explicit model to the connection allowlist</div><div class="inline"><input data-field="custom" aria-label="Custom model ID" placeholder="Model ID"><button data-action="custom">Add model</button></div><p class="hint">Adding an ID does not verify availability. This switches all-model access to an explicit allowlist.</p>' : ""}`;
        }
        removalSection() {
            const provider = this.state?.management?.providers.find((p) => p.id === this.selected);
            if (this.adding ||
                !this.state?.management?.removalSupported ||
                !provider ||
                provider.kind === "extension")
                return "";
            if (!this.removalPending)
                return `<section class="remove-provider"><button data-action="remove-provider" ${this.busy ? "disabled" : ""}>Remove provider</button><p class="hint">Remove this instance from the host. Native sign-ins and stored keys stay on this machine.</p></section>`;
            return `<section class="remove-provider" role="group" aria-label="Confirm provider removal"><strong>Remove ${escape(provider.name ?? provider.id)}?</strong><p class="hint">New runs cannot use this instance. Active runs continue. Existing grants keep their provider ID; explicitly adding that ID again makes it available to those grants.</p><div class="actions"><button data-action="cancel-remove" ${this.busy ? "disabled" : ""}>Keep provider</button><button data-action="confirm-remove" ${this.busy ? "disabled" : ""}>Confirm removal</button></div></section>`;
        }
        connectionSection() {
            if (!this.state?.canInvite)
                return "";
            return `<section class="links"><div class="row"><div><strong>Connect another application</strong><p class="hint">New invitations grant execution access to these provider instances.</p></div><button data-action="connections">Manage connections</button></div><div class="inline invitation-actions"><input data-field="subject" aria-label="Application name" placeholder="Application name"><button data-action="invite">Create invitation</button></div>${this.invite ? `<label for="new-invite" class="section-label">One-use invitation · expires ${escape(new Date(this.invite.expiresAt).toLocaleTimeString())}</label><textarea id="new-invite" readonly>${escape(this.invite.invitation)}</textarea><button data-action="copy-invite">Copy invitation</button>` : ""}${this.links ? [...this.links.connections, ...this.links.invitations].map((link) => `<div class="connections"><div><strong>${escape(link.grant.subject)}</strong><div class="connection-meta">${escape(link.grant.providers.join(", ") || "Management only")} · expires ${escape(new Date(link.expiresAt).toLocaleDateString())}</div></div><button data-action="revoke" data-id="${escape(link.id)}">Revoke</button></div>`).join("") || '<p class="hint">No active paired connections.</p>' : ""}</section>`;
        }
        render() {
            const focused = this.root.activeElement, focusField = focused?.dataset.field, selection = focused?.selectionStart;
            const focusSelector = focused &&
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
                    .map((name) => `[${name}="${CSS.escape(focused.getAttribute(name))}"]`)
                    .join("");
            if (focusSelector && this.busy)
                this.pendingFocus = focusSelector;
            const state = this.state, selected = state?.providers.find((p) => p.id === this.selected);
            const connected = state?.connected === true;
            const header = `<header class="top"><div><div class="eyebrow">AgenticDriver</div><h2>Providers & connections</h2></div><div class="actions">${connected ? `<span class="pill live host-label" title="${escape(state.connection?.url ?? "")}">● ${escape(state.connection?.label ?? "Connected host")}</span><button data-action="refresh" ${this.busy ? "disabled" : ""} aria-label="Refresh providers">↻ Refresh</button>${state.canDisconnect ? '<button data-action="disconnect">Disconnect</button>' : ""}` : `<span class="pill">Not connected</span>${state?.connection ? '<button data-action="refresh">Retry connection</button>' : ""}`}</div></header>`;
            let content;
            if (!state && this.busy)
                content =
                    '<div class="loading" role="status">Loading your connection…</div>';
            else if (!connected)
                content = this.disconnected();
            else
                content = `<div class="layout"><aside class="sidebar" aria-label="Provider instances"><div class="side-label">${state.providers.length} connected instances</div>${state.providers
                    .map((provider) => {
                    const config = state.management?.providers.find((p) => p.id === provider.id);
                    return `<div class="provider ${provider.id === this.selected && !this.adding ? "selected" : ""}"><button class="select" data-action="select" data-id="${escape(provider.id)}" aria-pressed="${provider.id === this.selected && !this.adding}">${this.avatar(provider)}<span class="provider-copy"><strong>${escape(provider.name)}</strong><small>${config?.enabled === false ? "Disabled" : provider.authMode === "cli-session" ? "Subscription / local account" : provider.authMode === "api-key" ? "API connection" : "Offline fixture"}</small><small>${provider.modelCatalog?.models.length ?? 0} reported models</small></span></button>${config && config.kind !== "extension" ? `<button class="switch" role="switch" aria-label="Enable ${escape(provider.name)}" aria-checked="${config.enabled !== false}" data-action="enable" data-id="${escape(provider.id)}" ${this.busy ? "disabled" : ""}></button>` : ""}</div>`;
                })
                    .join("")}${state.management ? '<button class="new-provider" data-action="add">＋ Add provider</button>' : ""}</aside><main class="detail"><div class="detail-head"><div><h3>${this.adding ? "Add a provider" : escape(selected?.name ?? (state.management ? "No providers configured" : "No providers granted"))}</h3><div class="hint">${this.adding ? "Configure an account on the connected host." : escape(this.draft?.accountId ?? selected?.id ?? (state.management ? "Configure an account on the connected host." : "Ask the host operator for a provider grant."))}</div></div>${!this.adding && selected?.health ? `<span class="pill">${escape(selected.health.status)}</span>` : ""}</div>${!this.adding && selected?.health ? `<p class="hint">${escape(selected.health.message)} · Checked ${escape(new Date(selected.health.checkedAt).toLocaleTimeString())}</p>` : ""}${!this.adding && selected ? `<div class="tabs" role="tablist" aria-label="Provider settings"><button role="tab" id="tab-runtime" aria-controls="tab-content" tabindex="${this.tab === "runtime" ? 0 : -1}" aria-selected="${this.tab === "runtime"}" data-action="tab" data-tab="runtime">Settings</button><button role="tab" id="tab-models" aria-controls="tab-content" tabindex="${this.tab === "models" ? 0 : -1}" aria-selected="${this.tab === "models"}" data-action="tab" data-tab="models">Models <span class="small">${this.models(selected).length}</span></button></div>` : ""}${!this.adding && selected ? `<div id="tab-content" role="tabpanel" aria-labelledby="tab-${this.tab}">` : ""}${this.tab === "models" && !this.adding && selected ? this.modelList(selected) : this.runtime(selected)}${!this.adding && selected ? "</div>" : ""}${this.message ? `<p class="small success" role="status">${escape(this.message)}</p>` : ""}${this.removalSection()}${this.connectionSection()}</main></div>`;
            this.root.innerHTML = `<section class="shell" aria-label="AgenticDriver provider management">${header}${this.failure ? `<div class="notice error" role="alert">${escape(this.failure)}</div>` : ""}${connected ? this.setupCards() : ""}${content}</section>`;
            if (focusField === "query" || focusField === "provider-query") {
                const input = this.root.querySelector(`[data-field="${focusField}"]`);
                input?.focus();
                if (selection !== null && selection !== undefined)
                    input?.setSelectionRange(selection, selection);
            }
            else {
                const selector = focusSelector || this.pendingFocus;
                if (selector &&
                    (document.activeElement === this ||
                        document.activeElement === document.body))
                    this.root.querySelector(selector)?.focus();
            }
            if (!this.busy)
                this.pendingFocus = undefined;
        }
    }
    registry.define("agenticdriver-providers", Panel);
}
if (typeof customElements !== "undefined")
    registerProviderPanel();

import "./provider-panel.js";
const api = window.agenticDesktop;
const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmt = (value) =>
  typeof value === "number"
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
        value,
      )
    : "Unknown";
const date = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : "Not reported";
const relative = (value) => {
  const seconds = (Date.now() - Date.parse(value)) / 1000;
  return Number.isFinite(seconds)
    ? seconds < 60
      ? "Just now"
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ago`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)}h ago`
          : `${Math.floor(seconds / 86400)}d ago`
    : "Not reported";
};
let overview,
  view = "providers",
  providerPanel,
  usageData,
  links,
  invitation,
  busy = false,
  generation = 0;
const pages = {
  providers: [
    "PROVIDERS & ACCOUNTS",
    "Your agent workspace",
    "Manage the providers and models available to your applications.",
  ],
  usage: [
    "USAGE & QUOTAS",
    "Know what’s available",
    "Provider usage and quota snapshots from your Usagestat backend.",
  ],
  connections: [
    "APPLICATION CONNECTIONS",
    "Put your agents to work",
    "Connect applications, review their access and see request activity.",
  ],
  hosts: [
    "LOCAL & REMOTE",
    "Choose where agents run",
    "Manage this computer’s host or pair with another AgenticDriver host.",
  ],
};
async function request(input) {
  const result = await api.request(input);
  if (result.error)
    throw Object.assign(new Error(result.error.message), {
      code: result.error.code,
    });
  return result.value;
}
function notice(message, error = false) {
  const box = $("#notification");
  box.hidden = !message;
  box.textContent = message;
  box.classList.toggle("error", error);
}
async function action(fn) {
  if (busy) return;
  busy = true;
  notice("");
  try {
    await fn();
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
  }
}
function selected() {
  return overview?.selectedHost ?? "local";
}
function updateHeader() {
  if (!overview) return;
  const select = $("#host-select");
  const options =
    `<option value="local">This computer${overview.local.running ? " · Running" : " · Stopped"}</option>` +
    overview.hosts
      .map((h) => `<option value="${escape(h.id)}">${escape(h.label)}</option>`)
      .join("");
  if (select.innerHTML !== options) select.innerHTML = options;
  if (select.value !== selected()) select.value = selected();
  const indicator = $("#local-indicator");
  indicator.classList.toggle("running", overview.local.running);
  indicator.querySelector("span").textContent = overview.local.running
    ? "Local host running"
    : "Local host stopped";
  $("#connection-count").textContent = overview.local.connections || "";
  $("#endpoint").textContent =
    (selected() === "local"
      ? overview.local.url
      : overview.hosts.find((h) => h.id === selected())?.url) ??
    "Private local workspace";
}
async function refreshOverview() {
  overview = await request({ action: "overview" });
  updateHeader();
}
async function show(next) {
  view = next;
  const current = ++generation;
  invitation = undefined;
  notice("");
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.view === view);
    button.setAttribute(
      "aria-current",
      button.dataset.view === view ? "page" : "false",
    );
  });
  for (const key of Object.keys(pages)) $(`#${key}-view`).hidden = key !== view;
  $("#breadcrumb-view").textContent = view[0].toUpperCase() + view.slice(1);
  $("#eyebrow").textContent = pages[view][0];
  $("#title").textContent = pages[view][1];
  $("#subtitle").textContent = pages[view][2];
  if (view === "hosts") renderHosts();
  else if (view === "providers") await providers(current);
  else if (view === "connections") await connections(current);
  else await usage(current);
}
async function providers(current) {
  const mount = $("#provider-mount");
  mount.replaceChildren();
  providerPanel = undefined;
  const state = $("#provider-state");
  if (selected() === "local" && !overview.local.running) {
    state.innerHTML = `<div class="card empty"><div class="empty-icon">◈</div><h2>Start your local host</h2><p>Add providers and connect applications from this private workspace. Your saved settings will be loaded when the host starts.</p><button class="button primary" data-action="start">Start local host</button></div>`;
    return;
  }
  state.innerHTML =
    '<div class="notice">All reported models are shown. Choose model access per provider connection; applications receive the access you grant.</div>';
  const hostId = selected();
  const panel = document.createElement("agenticdriver-providers");
  panel.transport = (req) => request({ action: "panel", hostId, request: req });
  if (current !== generation) return;
  providerPanel = panel;
  mount.append(panel);
}
function renderHosts() {
  const local = overview.local;
  $("#hosts-view").innerHTML = `
    <div class="card host-row"><div class="row"><div><div class="chips"><h2>This computer</h2><span class="badge ${local.running ? "green" : ""}"><i class="dot ${local.running ? "running" : ""}"></i>${local.running ? "Running" : "Stopped"}</span></div><p class="address">${escape(local.url ?? "An endpoint is assigned on first start")}</p><p class="muted">A private host managed by this app. ${local.activeRequests} request${local.activeRequests === 1 ? "" : "s"} in progress.</p></div><div class="host-actions"><button class="button ${local.running ? "quiet" : "primary"}" data-action="${local.running ? "stop" : "start"}">${local.running ? "Stop host" : "Start host"}</button><button class="button" data-action="select" data-host="local">Manage providers</button></div></div>${local.error ? `<div class="notice warning">${escape(local.error.message)}</div>` : ""}<label class="check"><input type="checkbox" id="startup" ${overview.startLocalAtLaunch ? "checked" : ""}>Start the local host when AgenticDriver opens</label><p class="help">Closing the app stops its host. Existing hosts started elsewhere are managed separately.</p><div id="stop-confirm" hidden class="notice warning">Stopping interrupts requests on this local host.<div class="actions"><button class="button danger" data-action="interrupt">Stop and interrupt requests</button><button class="button quiet" data-action="cancel-stop">Keep running</button></div></div></div>
    ${overview.hosts.map((h) => `<div class="card host-row"><div class="row"><div><h2>${escape(h.label)}</h2><p class="address">${escape(h.url)}</p><p class="muted">Connection expires ${escape(date(h.expiresAt))}</p></div><div class="host-actions"><button class="button" data-action="select" data-host="${h.id}">Manage providers</button><button class="button quiet" data-action="forget" data-host="${h.id}">Remove</button></div></div></div>`).join("")}
    <div class="card"><div class="card-head"><div><h2>Connect another host</h2><p class="muted">Paste a one-use invitation from the host you want to manage.</p></div><span class="badge">Local or HTTPS</span></div><form id="connect-form" class="stack"><label class="field">Name<input name="label" required maxlength="80" placeholder="Workstation, home server…" autocomplete="off"></label><label class="field">Connection invitation<textarea name="invitation" required placeholder="ad1.…" spellcheck="false" autocomplete="off"></textarea></label><p class="help">A localhost invitation connects to this computer. Remote hosts need a reachable HTTPS endpoint or your existing secure tunnel. Management controls require an operator invitation.</p><div><button class="button primary" type="submit">Connect host</button></div></form></div>`;
}
async function connections(current) {
  $("#connections-view").innerHTML =
    '<div class="card"><p class="muted">Reading connections…</p></div>';
  const hostId = selected();
  try {
    const [next, snapshot] = await Promise.all([
      request({ action: "connections", hostId }),
      request({ action: "panel", hostId, request: { action: "snapshot" } }),
    ]);
    if (current !== generation) return;
    links = next;
    const providers = snapshot.management?.providers ?? [];
    $("#connections-view").innerHTML = `
      <div class="summary-grid" id="connection-summary"></div>
      <div class="card"><div class="card-head"><div><h2>Application access</h2><p class="muted">Counts include status checks and model streams observed by this host process. They do not indicate a persistent online connection.</p></div><span class="badge" id="connections-updated">Just refreshed</span></div><div id="connection-list"></div></div>
      <div class="card"><div class="card-head"><div><h2>Connect a new application</h2><p class="muted">Create an invitation, then paste it into the application’s AgenticDriver settings.</p></div><span class="badge">One use · 10 minutes</span></div><form id="invite-form" class="stack"><label class="field">Application name<input name="subject" required maxlength="128" placeholder="LitAgent, Brandstorm, AI Workspace…"></label><fieldset><legend>Provider access</legend><div class="provider-checks">${providers.map((p) => `<label class="check"><input type="checkbox" name="provider" value="${escape(p.id)}" checked><span>${escape(p.name || p.id)} <small class="muted">${escape(p.kind)}</small></span></label>`).join("") || '<p class="muted">Add a provider first, or create a management-only invitation.</p>'}</div></fieldset><div class="fields"><label class="field">Connection lifetime<select name="lifetime"><option value="86400">1 day</option><option value="604800">7 days</option><option value="2592000" selected>30 days</option><option value="7776000">90 days</option></select></label><label class="check"><input type="checkbox" name="manage"><span>Allow provider management<br><small class="muted">Can edit providers and issue or revoke connection grants.</small></span></label></div><div><button class="button primary" type="submit">Create invitation</button></div></form><div id="invitation-result" hidden></div></div>`;
    renderConnectionList();
  } catch (error) {
    if (current === generation)
      $("#connections-view").innerHTML =
        `<div class="card empty"><div class="empty-icon">⇄</div><h2>Connection management unavailable</h2><p>${escape(error.message)}</p><button class="button" data-view="hosts">Open hosts</button></div>`;
  }
}
function renderConnectionList() {
  if (!links || !$("#connection-list")) return;
  const observed = links.connections.filter(
    (c) => c.activeRequests !== undefined,
  );
  const active = observed.reduce((sum, c) => sum + c.activeRequests, 0);
  $("#connection-summary").innerHTML =
    `<div class="summary"><span>Authorized applications</span><strong>${links.connections.length}</strong><p>Current unexpired grants</p></div><div class="summary"><span>Requests in progress</span><strong>${links.connections.length && !observed.length ? "Unknown" : `${active}${observed.length < links.connections.length ? "+" : ""}`}</strong><p>${observed.length} connection${observed.length === 1 ? "" : "s"} observed this session</p></div><div class="summary"><span>Open invitations</span><strong>${links.invitations.length}</strong><p>Available for one exchange</p></div>`;
  const row = (c, pending) =>
    `<div class="connection-row"><div><strong>${escape(c.grant.subject)}</strong><div class="connection-details"><span class="badge ${!pending && c.activeRequests ? "green" : ""}">${pending ? "Invitation" : c.activeRequests === undefined ? "No activity reported" : `${c.activeRequests} in progress`}</span>${c.grant.manageProviders ? '<span class="badge amber">Management</span>' : ""}</div><div class="connection-meta">${escape(c.grant.providers.join(", ") || "No execution grants")} · Expires ${escape(date(c.expiresAt))}${!pending ? `<br>Last request: ${escape(c.lastSeenAt ? relative(c.lastSeenAt) : "Not observed this session")}` : ""}</div></div><button class="button quiet" data-action="revoke" data-id="${c.id}">Revoke</button></div>`;
  $("#connection-list").innerHTML =
    links.connections.map((c) => row(c, false)).join("") +
      links.invitations.map((c) => row(c, true)).join("") ||
    '<div class="empty"><div class="empty-icon">⇄</div><h3>No applications connected yet</h3><p>Create an invitation below to give your first application access.</p></div>';
  $("#connections-updated").textContent =
    `Checked ${new Date().toLocaleTimeString()}`;
}
async function usage(current) {
  $("#usage-view").innerHTML =
    '<div class="card"><p class="muted">Reading Usagestat…</p></div>';
  const data = await request({ action: "usage" });
  if (current !== generation) return;
  usageData = data;
  renderUsage();
}
function renderUsage() {
  const data = usageData;
  const errors = Object.entries(data.sections)
    .filter(([, value]) => value === "unavailable")
    .map(([key]) => key);
  const metric = (m) => {
    if (m.type === "progress") {
      const percent =
        m.limit > 0 && typeof m.used === "number"
          ? (m.used / m.limit) * 100
          : undefined;
      const unit =
        m.format?.kind === "percent"
          ? "%"
          : m.format?.kind === "dollars"
            ? "USD"
            : m.format?.suffix || m.unit || "";
      return `<div class="resource"><h3>${escape(m.label)}</h3><div class="resource-value">${fmt(m.used)} <span class="resource-unit">${m.limit === undefined ? "· limit not reported" : `/ ${fmt(m.limit)}`} ${escape(unit)}</span></div>${percent !== undefined ? `<div class="meter"><div class="meter-fill ${percent >= 85 ? "warn" : ""}" style="width:${Math.max(0, Math.min(100, percent))}%"></div></div>` : ""}<small>${m.resetsAt ? `Resets ${escape(date(m.resetsAt))}` : "Reset not reported"}</small>${m.detail ? `<p class="help">${escape(m.detail)}</p>` : ""}</div>`;
    }
    if (m.type === "barChart") {
      const max = Math.max(1, ...(m.points ?? []).map((p) => p.value));
      return `<div class="resource"><h3>${escape(m.label)}</h3>${(m.points ?? []).map((p) => `<div class="row chart-label"><span>${escape(p.label)}</span><span>${escape(p.valueLabel ?? fmt(p.value))}</span></div><div class="meter"><div class="meter-fill" style="width:${Math.max(0, Math.min(100, (p.value / max) * 100))}%"></div></div>`).join("")}</div>`;
    }
    const value = m.type === "badge" ? m.text : (m.value ?? m.used);
    return `<div class="resource"><h3>${escape(m.label)}</h3><p class="${m.type === "badge" ? "help" : "resource-value"}">${escape(typeof value === "number" ? fmt(value) : (value ?? "Not reported"))} <span class="resource-unit">${escape(m.unit || m.currency || "")}</span></p>${m.subtitle ? `<p class="help">${escape(m.subtitle)}</p>` : ""}</div>`;
  };
  const freshness = (fetchedAt) => {
    const age = Date.now() - Date.parse(fetchedAt);
    return `<span class="badge ${!Number.isFinite(age) || age > 900000 ? "amber" : ""}">${escape(relative(fetchedAt))}${age > 900000 ? " · Stale" : ""}</span>`;
  };
  $("#usage-view").innerHTML =
    `<div class="notice">Usagestat supplies these provider snapshots. They are separate from per-run SDK measurements and are not automatically matched to a host account.</div>${errors.length ? `<div class="notice warning">${data.available ? `Some Usagestat sections are unavailable: ${escape(errors.join(", "))}.` : "Usagestat is not reachable. Connect your existing backend below to see usage; missing data is not zero usage."}</div>` : ""}<div class="resource-grid">${data.snapshots.map((s) => `<article class="card"><div class="card-head"><div><h2>${escape(s.displayName)}</h2><p class="muted">${escape(s.plan || "Plan not reported")} · ${escape(s.source || "Source not reported")}</p>${s.state && s.state !== "ready" ? `<span class="badge amber">${escape(s.state)}</span>` : ""}</div>${freshness(s.fetchedAt)}</div>${s.metrics.map(metric).join("") || '<p class="muted">No measurements reported.</p>'}<p class="help">Snapshot: ${escape(date(s.fetchedAt))}</p></article>`).join("")}</div>${!data.snapshots.length ? '<div class="card empty"><div class="empty-icon">▥</div><h2>No usage snapshots available</h2><p>Usagestat collects the data. This app reads its existing usage API, including subscription progress and quota windows.</p></div>' : ""}<div class="card" style="margin-top:22px"><details ${!data.available ? "open" : ""}><summary>Usagestat connection · ${escape(data.url)}</summary><form id="usage-form" class="fields"><label class="field full">Service URL<input name="url" required type="url" value="${escape(overview.usage.url)}" placeholder="http://127.0.0.1:6736"></label><label class="field">Replace service token<input name="token" type="password" autocomplete="new-password" placeholder="${overview.usage.hasToken ? "Saved privately · leave blank to keep" : "Optional for a local service"}"></label><label class="check"><input type="checkbox" name="clearToken"><span>Remove saved service token</span></label><p class="help full">Provider credentials are managed by Usagestat. Changing the service URL clears its saved token unless you supply a new one. Remote services require HTTPS.</p><div class="full"><button class="button" type="submit">Save connection</button></div></form></details><p class="help">Last checked: ${escape(date(data.checkedAt))}</p></div>`;
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.view) {
    void action(() => show(button.dataset.view));
    return;
  }
  const act = button.dataset.action;
  if (!act) return;
  void action(async () => {
    if (act === "start" || act === "stop" || act === "interrupt") {
      try {
        overview = await request({
          action: act === "start" ? "start" : "stop",
          ...(act === "interrupt" ? { interrupt: true } : {}),
        });
      } catch (error) {
        if (error.code === "HOST_BUSY" && $("#stop-confirm")) {
          $("#stop-confirm").hidden = false;
          return;
        }
        throw error;
      }
      updateHeader();
      await show(view);
    } else if (act === "cancel-stop") $("#stop-confirm").hidden = true;
    else if (act === "select") {
      overview = await request({
        action: "select",
        hostId: button.dataset.host,
      });
      updateHeader();
      await show("providers");
    } else if (act === "revoke") {
      await request({
        action: "revoke",
        hostId: selected(),
        connectionId: button.dataset.id,
      });
      links = await request({ action: "connections", hostId: selected() });
      renderConnectionList();
      notice("The connection or invitation was revoked.");
    } else if (act === "copy") {
      await api.copyInvitation(invitation);
      notice("Invitation copied. It can be exchanged once before it expires.");
    } else if (act === "forget") {
      if (button.dataset.confirm !== "yes") {
        button.dataset.confirm = "yes";
        button.textContent = "Confirm removal";
        notice(
          "This removes the saved credential from this app. It does not stop the remote host or revoke other applications.",
        );
        return;
      }
      overview = await request({
        action: "forget",
        hostId: button.dataset.host,
      });
      updateHeader();
      renderHosts();
    }
  });
});
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!["connect-form", "invite-form", "usage-form"].includes(form.id)) return;
  event.preventDefault();
  const data = new FormData(form);
  const hostId = selected();
  void action(async () => {
    if (form.id === "connect-form") {
      const value = data.get("invitation");
      form.elements.invitation.value = "";
      overview = await request({
        action: "connect",
        label: data.get("label"),
        invitation: value,
      });
      updateHeader();
      await show("providers");
      notice("Host connected. Your credential is saved privately.");
    } else if (form.id === "invite-form") {
      const result = await request({
        action: "invite",
        hostId,
        input: {
          grant: {
            subject: data.get("subject"),
            providers: data.getAll("provider"),
            manageProviders: data.get("manage") === "on",
          },
          connectionLifetimeSeconds: Number(data.get("lifetime")),
        },
      });
      invitation = result.invitation;
      const target = $("#invitation-result");
      target.hidden = false;
      target.innerHTML = `<div class="notice success" style="margin-top:20px"><strong>Ready to connect</strong><p>Paste this in the application’s connection settings. Expires ${escape(date(result.expiresAt))}.</p><label class="field">One-use invitation<textarea readonly class="invitation" spellcheck="false">${escape(invitation)}</textarea></label><div class="actions"><button class="button" data-action="copy">Copy invitation</button></div></div>`;
      links = await request({ action: "connections", hostId });
      renderConnectionList();
    } else {
      const token = data.get("token");
      form.elements.token.value = "";
      overview = await request({
        action: "usage-settings",
        url: data.get("url"),
        ...(token ? { token } : {}),
        clearToken: data.get("clearToken") === "on",
      });
      updateHeader();
      await show("usage");
    }
  });
});
$("#host-select").addEventListener("change", () => {
  void action(async () => {
    overview = await request({
      action: "select",
      hostId: $("#host-select").value,
    });
    updateHeader();
    await show(view);
  });
});
document.addEventListener("change", (event) => {
  if (event.target.id === "startup")
    void action(async () => {
      overview = await request({
        action: "startup",
        enabled: event.target.checked,
      });
      updateHeader();
    });
});
$("#page-refresh").addEventListener("click", () => {
  void action(async () => {
    await refreshOverview();
    if (view === "providers" && providerPanel)
      await providerPanel.refresh(true);
    else if (view === "connections" && $("#connection-list")) {
      links = await request({ action: "connections", hostId: selected() });
      renderConnectionList();
    } else await show(view);
  });
});
try {
  await refreshOverview();
  await show("providers");
  if (api.smoke) {
    // Apply the consuming app's strict style policy as an additional policy.
    const stylePolicy = document.createElement("meta");
    stylePolicy.httpEquiv = "Content-Security-Policy";
    stylePolicy.content = "style-src 'self'";
    document.head.append(stylePolicy);
    const styleViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      if (event.effectiveDirective.startsWith("style-src"))
        styleViolations.push(event.effectiveDirective);
    });
    const before = await request({
      action: "panel",
      hostId: "local",
      request: { action: "snapshot" },
    });
    await request({
      action: "panel",
      hostId: "local",
      request: {
        action: "configure",
        change: {
          revision: before.management.revision,
          provider: {
            kind: "mock",
            id: "desktop-smoke",
            accountId: "synthetic-only",
          },
        },
      },
    });
    const after = await request({
      action: "panel",
      hostId: "local",
      request: { action: "snapshot" },
    });
    // Real renderer regression, enabled only by the isolated --smoke-test harness.
    // The component transport below is synthetic; it never starts provider sign-in.
    const setupState = structuredClone(after);
    setupState.connection = { id: "renderer-fixture", label: "Synthetic host" };
    setupState.canInvite = false;
    setupState.setup = { version: 1, attempts: [] };
    const setupPanel = document.createElement("agenticdriver-providers");
    let pendingProvider,
      confirmations = 0;
    const check = (ok) => {
      if (!ok) throw new Error("Provider sign-in UI regression.");
    };
    const until = async (condition) => {
      for (let i = 0; i < 200; i++) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      check(false);
    };
    setupPanel.transport = async (input) => {
      if (input.action === "snapshot") return structuredClone(setupState);
      check(input.action === "setup");
      const request = input.request;
      if (request.action === "start") {
        pendingProvider = request.provider;
        check(!Object.hasOwn(pendingProvider, "accountDirectory"));
        const now = new Date().toISOString();
        setupState.setup.attempts = [
          {
            id: crypto.randomUUID(),
            providerId: pendingProvider.id,
            accountId: pendingProvider.accountId,
            name: pendingProvider.name,
            revision: request.revision,
            method: request.method,
            phase: "waiting",
            createdAt: now,
            updatedAt: now,
            expiresAt: new Date(Date.now() + 900000).toISOString(),
            interaction: {
              type: "device-code",
              verificationUrl: "https://auth.openai.com/codex/device",
              userCode: "TEST-CODE",
            },
          },
        ];
      } else if (request.action === "cancel") {
        setupState.setup.attempts[0].phase = "cancelled";
        delete setupState.setup.attempts[0].interaction;
      } else if (request.action === "accept") {
        check(setupState.setup.attempts[0].phase === "ready");
        confirmations++;
        setupState.setup.attempts[0].phase = "succeeded";
        setupState.management.providers.push({
          ...pendingProvider,
          accountDirectory: "/synthetic/owned-profile",
        });
        setupState.providers.push({
          ...setupState.providers[0],
          id: pendingProvider.id,
          name: pendingProvider.name,
          vendor: "codex",
          authMode: "cli-session",
        });
      } else check(request.action === "list");
      return structuredClone(setupState.setup);
    };
    document.body.append(setupPanel);
    const root = setupPanel.shadowRoot;
    const click = (selector) => {
      const button = root.querySelector(selector);
      check(button && !button.disabled);
      button.click();
    };
    const initialName = setupState.management.providers[0].name ?? "";
    try {
      await setupPanel.refresh();
      const begin = async () => {
        click('[data-action="add"]');
        click('[data-kind="codex"]');
        const name = root.querySelector('[data-config="name"]');
        name.value = "Synthetic owned account";
        name.dispatchEvent(
          new InputEvent("input", { bubbles: true, composed: true }),
        );
        click('[data-action="connect-provider"]');
        await until(
          () =>
            root.querySelector('[data-action="setup-cancel"]') &&
            !root.querySelector('[data-action="setup-cancel"]').disabled,
        );
        check(root.querySelector('[data-config="name"]').value === initialName);
        check(!root.querySelector('[data-config="binary"]'));
        check(!root.querySelector('[data-action="setup-accept"]'));
      };
      await begin();
      click('[data-action="setup-cancel"]');
      await until(() =>
        root
          .querySelector(".setup-attempts")
          .textContent.includes("Sign-in cancelled"),
      );
      check(root.querySelector('[data-config="name"]').value === initialName);
      await begin();
      const attempt = setupState.setup.attempts[0];
      attempt.phase = "ready";
      delete attempt.interaction;
      attempt.account = {
        email: "renderer@example.invalid",
        plan: "synthetic",
      };
      await setupPanel.refresh();
      check(
        confirmations === 0 &&
          root
            .querySelector(".setup-attempts")
            .textContent.includes("renderer@example.invalid"),
      );
      click('[data-action="setup-accept"]');
      await until(
        () =>
          root.querySelector('[data-action="select"][aria-pressed="true"]')
            ?.dataset.id === pendingProvider.id,
      );
      check(
        confirmations === 1 &&
          root.querySelector('[data-config="name"]').value ===
            "Synthetic owned account",
      );
      delete setupState.setup;
      await setupPanel.refresh();
      click('[data-action="add"]');
      click('[data-kind="codex"]');
      check(!root.querySelector('[data-method="codex-device"]'));
    } finally {
      setupPanel.remove();
    }
    const livePanel = document.querySelector("agenticdriver-providers");
    await livePanel.refresh();
    const liveRoot = livePanel.shadowRoot;
    check(
      getComputedStyle(liveRoot.querySelector(".layout")).display === "grid",
    );
    liveRoot.querySelector('[data-action="remove-provider"]').click();
    check(Boolean(liveRoot.querySelector('[data-action="cancel-remove"]')));
    liveRoot.querySelector('[data-action="cancel-remove"]').click();
    check(Boolean(liveRoot.querySelector('[data-action="remove-provider"]')));
    liveRoot.querySelector('[data-action="remove-provider"]').click();
    liveRoot.querySelector('[data-action="confirm-remove"]').click();
    await until(() => liveRoot.textContent.includes("Provider removed."));
    const removed = await request({
      action: "panel",
      hostId: "local",
      request: { action: "snapshot" },
    });
    check(!removed.providers.some((p) => p.id === "desktop-smoke"));
    check(styleViolations.length === 0);
    await api.reportSmoke({
      providerSetupUi: true,
      providerRemovalUi: true,
      strictStyleCsp: true,
      nodeUnavailable:
        typeof window.require === "undefined" &&
        typeof window.process === "undefined",
      providerAdded:
        after.providers.some((p) => p.id === "desktop-smoke") &&
        Boolean(document.querySelector("agenticdriver-providers")),
    });
  }
} catch (error) {
  notice(error.message, true);
  if (api?.smoke)
    await api.reportSmoke({ startupError: error.code ?? "STARTUP_FAILED" });
}
setInterval(() => {
  if (busy || document.hidden) return;
  void (async () => {
    await refreshOverview();
    if (view === "connections" && $("#connection-list")) {
      const hostId = selected();
      const next = await request({ action: "connections", hostId });
      if (selected() === hostId && view === "connections") {
        links = next;
        renderConnectionList();
      }
    }
  })().catch(() => {
    const indicator = $("#local-indicator");
    indicator.classList.remove("running");
    indicator.querySelector("span").textContent = "Host status unavailable";
    if (view === "connections" && $("#connections-updated"))
      $("#connections-updated").textContent =
        "Refresh failed · showing last observation";
  });
}, 5000);

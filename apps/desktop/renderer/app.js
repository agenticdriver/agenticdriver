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
const invitationPreviews = new WeakMap();
let previewTimer,
  previewSequence = 0;
const destinationPreviews = new WeakMap();
let destinationTimer,
  destinationSequence = 0;
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
  document.body.setAttribute("aria-busy", "true");
  $("#host-select").disabled = true;
  notice("");
  try {
    await fn();
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    document.body.setAttribute("aria-busy", "false");
    $("#host-select").disabled = false;
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
  clearInvitationResult();
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
    '<div class="notice">All reported models are shown. Choose model access per provider connection; applications receive the access you grant.</div>' +
    (selected() !== "local"
      ? `<div class="remote-tools"><span class="muted">Using ${escape(overview.hosts.find((h) => h.id === selected())?.label)}</span><button class="button quiet" data-action="check-host" data-host="${selected()}">Check connection</button><button class="button quiet" data-view="hosts">Host settings</button></div>`
      : "");
  const hostId = selected();
  const panel = document.createElement("agenticdriver-providers");
  panel.transport = (req) => request({ action: "panel", hostId, request: req });
  if (current !== generation) return;
  providerPanel = panel;
  mount.append(panel);
}
function hostStatus(host) {
  const expired = host.expiresAt && Date.parse(host.expiresAt) <= Date.now();
  const check = expired
    ? {
        status: "expired",
        message:
          "This connection expired. Use a new invitation below to reconnect.",
      }
    : host.check;
  const labels = {
    connected: "Credential accepted",
    expired: "Expired",
    rejected: "Access rejected",
    "credential-unavailable": "Credential unavailable",
    incompatible: "Incompatible host",
    certificate: "Certificate needs attention",
    unreachable: "Unreachable",
    stopped: "Stopped",
  };
  return `<span class="badge ${check?.status === "connected" ? "green" : check ? "amber" : ""}">${escape(labels[check?.status] ?? "Not checked")}</span><p class="help">${escape(check?.message ?? "Check the host and saved credential without running a model.")}${check?.checkedAt ? `<br>Checked ${escape(relative(check.checkedAt))}${check.protocolVersion ? ` · Protocol ${escape(check.protocolVersion)} · ${check.canManageProviders ? "Provider management allowed" : "No provider management grant"}` : ""}` : ""}</p>`;
}
function refreshHostStatuses() {
  for (const host of [overview.local, ...overview.hosts]) {
    const target = document.querySelector(`[data-host-status="${host.id}"]`);
    if (target) target.innerHTML = hostStatus(host);
  }
}
function invitationField() {
  return `<label class="field">Connection invitation<textarea name="invitation" required placeholder="ad1.…" spellcheck="false" autocomplete="off"></textarea></label><div class="invitation-preview" aria-live="polite"></div>`;
}
async function previewInvitation(form) {
  const value = form.elements.invitation.value.trim();
  const target = form.querySelector(".invitation-preview");
  const submit = form.querySelector('[type="submit"]');
  const sequence = ++previewSequence;
  invitationPreviews.delete(form);
  submit.disabled = true;
  target.textContent = value ? "Reading invitation…" : "";
  if (!value) return;
  try {
    const preview = await request({
      action: "preview-invitation",
      invitation: value,
    });
    if (sequence !== previewSequence || !form.isConnected) return;
    const existing = overview.hosts.find((h) => h.id === form.dataset.host);
    const mismatch = existing && existing.url !== preview.url;
    target.innerHTML = `<div class="notice ${mismatch ? "warning" : ""}"><strong>Invitation destination</strong><p class="address">${escape(preview.url)}</p><p>${mismatch ? "This address differs from the saved host. Add it as another host to keep your existing connection." : preview.location === "this-computer" ? "This address reaches this computer. A remote machine needs its own reachable HTTPS address or an existing secure tunnel." : "This is a remote host. Its HTTPS certificate will be verified when you connect."}</p><p class="help">The invitation has not been exchanged and no connection has been made.</p></div>`;
    if (!mismatch) {
      invitationPreviews.set(form, { value, url: preview.url });
      submit.disabled = false;
      if (form.elements.label && !form.elements.label.value.trim())
        form.elements.label.value = preview.suggestedLabel.slice(0, 80);
    }
  } catch {
    if (sequence === previewSequence && form.isConnected)
      target.innerHTML =
        '<p class="notice warning">Paste the complete one-use invitation beginning with ad1. from the selected host.</p>';
  }
}
function renderHosts() {
  const local = overview.local;
  $("#hosts-view").innerHTML = `
    <div class="card host-row"><div class="row"><div><div class="chips"><h2>This computer</h2><span class="badge ${local.running ? "green" : ""}"><i class="dot ${local.running ? "running" : ""}"></i>${local.running ? "Running" : "Stopped"}</span></div><p class="address">${escape(local.url ?? "An endpoint is assigned on first start")}</p><p class="muted">A private host managed by this app. ${local.activeRequests} request${local.activeRequests === 1 ? "" : "s"} in progress.</p></div><div class="host-actions"><button class="button ${local.running ? "quiet" : "primary"}" data-action="${local.running ? "stop" : "start"}">${local.running ? "Stop host" : "Start host"}</button><button class="button" data-action="select" data-host="local">Manage providers</button></div></div>${local.error ? `<div class="notice warning">${escape(local.error.message)}</div>` : ""}<label class="check"><input type="checkbox" id="startup" ${overview.startLocalAtLaunch ? "checked" : ""}>Start the local host when AgenticDriver opens</label><p class="help">Closing the app stops its host. Existing hosts started elsewhere are managed separately.</p><div id="stop-confirm" hidden class="notice warning">Stopping interrupts requests on this local host.<div class="actions"><button class="button danger" data-action="interrupt">Stop and interrupt requests</button><button class="button quiet" data-action="cancel-stop">Keep running</button></div></div></div>
    ${overview.hosts.map((h) => `<div class="card host-row"><div class="row"><div><h2>${escape(h.label)}</h2><p class="address">${escape(h.url)}</p><p class="muted">Connection expires ${escape(date(h.expiresAt))}</p></div><div class="host-actions"><button class="button" data-action="select" data-host="${h.id}">Open providers</button><button class="button quiet" data-action="check-host" data-host="${h.id}">Check connection</button></div></div><div data-host-status="${h.id}" role="status">${hostStatus(h)}</div><details class="host-options"><summary>Connection settings</summary><form class="rename-form fields" data-host="${h.id}"><label class="field">Name<input name="label" required maxlength="80" value="${escape(h.label)}" autocomplete="off"></label><div><button class="button" type="submit">Save name</button></div></form><h3>Reconnect this host</h3><p class="muted">Replace an expired or revoked credential with a new invitation from the same address. Your host name and saved provider preferences stay in place.</p><form class="reconnect-form stack" data-host="${h.id}">${invitationField()}<div><button class="button" type="submit" disabled>Reconnect host</button></div></form><p class="help">Previous grants remain valid until they expire or the host operator revokes them. Active requests are not interrupted.</p><button class="button quiet" data-action="forget" data-host="${h.id}">Remove saved host</button></details></div>`).join("")}
    <div class="card"><div class="card-head"><div><h2>Connect another host</h2><p class="muted">Paste an invitation and review where it will connect.</p></div><span class="badge">Local or HTTPS</span></div><form id="connect-form" class="stack">${invitationField()}<label class="field">Name<input name="label" required maxlength="80" placeholder="Workstation, home server…" autocomplete="off"></label><p class="help">The host operator creates an invitation in Connections or with agenticdriver pair. Each invitation is used once. Provider management needs a management grant.</p><div><button class="button primary" type="submit" disabled>Connect host</button></div></form></div>`;
}
function invitationDestinationFields(hostId) {
  return `<fieldset class="destination-fields"><legend>Where will the application backend connect?</legend><label class="field">Connection route<select name="destination"><option value="current">${hostId === "local" ? "On this computer" : "Use this host’s saved address"}</option><option value="https">Another computer · HTTPS</option>${hostId === "local" ? '<option value="tunnel">Another computer · SSH tunnel</option>' : ""}</select></label><label class="field" data-destination-field="https" hidden>Reachable HTTPS address<input name="clientUrl" type="url" required disabled placeholder="https://driver.example.com/agenticdriver/" autocomplete="off"></label><label class="field" data-destination-field="tunnel" hidden>Loopback port beside the application backend<input name="tunnelPort" type="number" value="17433" min="1024" max="65535" required disabled></label><div class="destination-preview" role="status"></div></fieldset>`;
}
function destinationInput(form) {
  const mode = form.elements.destination.value;
  return mode === "https"
    ? { mode, url: form.elements.clientUrl.value.trim() }
    : mode === "tunnel"
      ? { mode, port: Number(form.elements.tunnelPort.value) }
      : { mode };
}
async function previewDestination(form) {
  const input = destinationInput(form);
  const sequence = ++destinationSequence;
  destinationPreviews.delete(form);
  form.querySelector('[type="submit"]').disabled = true;
  for (const field of form.querySelectorAll("[data-destination-field]")) {
    field.hidden = field.dataset.destinationField !== input.mode;
    field.querySelector("input").disabled = field.hidden;
  }
  const target = form.querySelector(".destination-preview");
  target.textContent = "Reading destination…";
  try {
    const preview = await request({
      action: "preview-destination",
      hostId: selected(),
      destination: input,
    });
    if (sequence !== destinationSequence || !form.isConnected) return;
    const description =
      input.mode === "https"
        ? "Configure this HTTPS address to reach the selected host, including any path prefix. The connecting application will verify its certificate."
        : input.mode === "tunnel"
          ? "Start one of the tunnels below before using the invitation. The loopback listener must be beside the application backend, not only its browser."
          : preview.url.startsWith("http:")
            ? "This loopback address reaches this computer. An application backend running elsewhere needs HTTPS or a tunnel."
            : "Applications must be able to reach this saved HTTPS address from their backend.";
    target.innerHTML = `<div class="notice"><strong>Invitation destination</strong><p class="address">${escape(preview.url)}</p><p>${description}</p>${preview.commands ? `<details class="tunnel-instructions"><summary>SSH setup instructions</summary><p>Choose one direction. Replace the capitalized destination with your existing SSH account and machine; keep that SSH session running.</p><label class="field">Run on the application backend machine<textarea readonly class="command" aria-label="Forward SSH tunnel command">${escape(preview.commands.fromApplication)}</textarea></label><p class="help">This direction needs SSH access from the application machine to this computer.</p><label class="field">Or run on this computer<textarea readonly class="command" aria-label="Reverse SSH tunnel command">${escape(preview.commands.fromHost)}</textarea></label><p class="help">This direction needs SSH access from this computer to the application server. Both recipes request a loopback listener; the SSH server must permit forwarding and honor that bind address.</p></details>` : ""}<p class="help">No route has been verified and no access has been issued. ${input.mode === "tunnel" ? "AgenticDriver does not start SSH or configure the server." : "Operator credentials are never sent to this preview address."}</p></div>`;
    destinationPreviews.set(form, JSON.stringify(input));
    form.querySelector('[type="submit"]').disabled = false;
  } catch {
    if (sequence !== destinationSequence || !form.isConnected) return;
    target.innerHTML = `<p class="notice warning">${input.mode === "https" ? "Enter an absolute HTTPS address without credentials, a query string or a fragment." : input.mode === "tunnel" ? "Choose a loopback port between 1024 and 65535." : "Start the selected host before creating an invitation."}</p>`;
  }
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
      <div class="card"><div class="card-head"><div><h2>Connect a new application</h2><p class="muted">Create an invitation, then paste it into the application’s AgenticDriver settings.</p></div><span class="badge">One use · 10 minutes</span></div><form id="invite-form" class="stack"><label class="field">Application name<input name="subject" required maxlength="128" placeholder="LitAgent, Brandstorm, AI Workspace…"></label>${invitationDestinationFields(hostId)}<fieldset><legend>Provider access</legend><div class="provider-checks">${providers.map((p) => `<label class="check"><input type="checkbox" name="provider" value="${escape(p.id)}" checked><span>${escape(p.name || p.id)} <small class="muted">${escape(p.kind)}</small></span></label>`).join("") || '<p class="muted">Add a provider first, or create a management-only invitation.</p>'}</div></fieldset><div class="fields"><label class="field">Connection lifetime<select name="lifetime"><option value="86400">1 day</option><option value="604800">7 days</option><option value="2592000" selected>30 days</option><option value="7776000">90 days</option></select></label><label class="check"><input type="checkbox" name="manage"><span>Allow provider management<br><small class="muted">Can edit providers and issue or revoke connection grants.</small></span></label></div><div><button class="button primary" type="submit" disabled>Create invitation</button></div></form><div id="invitation-result" hidden></div></div>`;
    renderConnectionList();
    await previewDestination($("#invite-form"));
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
    } else if (act === "check-host") {
      const hostId = button.dataset.host;
      const label = button.textContent;
      button.disabled = true;
      button.textContent = "Checking…";
      try {
        const check = await request({ action: "check-host", hostId });
        await refreshOverview();
        refreshHostStatuses();
        notice(check.message, check.status !== "connected");
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
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
  if (
    !["connect-form", "invite-form", "usage-form"].includes(form.id) &&
    !form.matches(".reconnect-form,.rename-form")
  )
    return;
  event.preventDefault();
  const data = new FormData(form);
  const hostId = selected();
  void action(async () => {
    if (form.id === "connect-form" || form.matches(".reconnect-form")) {
      const value = String(data.get("invitation")).trim();
      if (invitationPreviews.get(form)?.value !== value) {
        await previewInvitation(form);
        notice(
          "Review the invitation destination, then choose Connect or Reconnect.",
        );
        return;
      }
      const reconnect = form.matches(".reconnect-form");
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.textContent = "Connecting…";
      form.elements.invitation.value = "";
      invitationPreviews.delete(form);
      form.querySelector(".invitation-preview").replaceChildren();
      try {
        overview = await request({
          action: reconnect ? "reconnect" : "connect",
          ...(reconnect
            ? { hostId: form.dataset.host }
            : { label: data.get("label") }),
          invitation: value,
        });
      } finally {
        submit.textContent = reconnect ? "Reconnect host" : "Connect host";
      }
      updateHeader();
      await show(reconnect ? "hosts" : "providers");
      notice(
        reconnect
          ? "New credential saved. Your host name and provider preferences were preserved."
          : "Host saved. Your credential is stored privately.",
      );
    } else if (form.matches(".rename-form")) {
      overview = await request({
        action: "rename-host",
        hostId: form.dataset.host,
        label: data.get("label"),
      });
      updateHeader();
      form.closest(".host-row").querySelector("h2").textContent =
        overview.hosts.find((h) => h.id === form.dataset.host).label;
      notice("Host name saved.");
    } else if (form.id === "invite-form") {
      const destination = destinationInput(form);
      if (destinationPreviews.get(form) !== JSON.stringify(destination)) {
        await previewDestination(form);
        notice("Review the destination, then create the invitation.");
        return;
      }
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.textContent = "Creating invitation…";
      form.inert = true;
      clearInvitationResult();
      let result;
      try {
        result = await request({
          action: "invite",
          hostId,
          destination,
          input: {
            grant: {
              subject: data.get("subject"),
              providers: data.getAll("provider"),
              manageProviders: data.get("manage") === "on",
            },
            connectionLifetimeSeconds: Number(data.get("lifetime")),
          },
        });
      } finally {
        form.inert = false;
        submit.disabled = false;
        submit.textContent = "Create invitation";
      }
      invitation = result.invitation;
      const target = $("#invitation-result");
      target.hidden = false;
      target.innerHTML = `<div class="notice success invitation-result"><strong>Invitation created</strong><p class="address">${escape(result.destination.url)}</p><p>Paste this into the application’s AgenticDriver settings. Expires ${escape(date(result.expiresAt))}. The application backend must be able to reach this address; the route has not been tested.</p><label class="field">One-use invitation<textarea readonly class="invitation" spellcheck="false">${escape(invitation)}</textarea></label><div class="actions"><button class="button" data-action="copy">Copy invitation</button></div></div>`;
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
function clearInvitationResult() {
  invitation = undefined;
  const target = $("#invitation-result");
  if (target) {
    target.hidden = true;
    target.replaceChildren();
  }
}
document.addEventListener("input", (event) => {
  if (event.target.form?.id === "invite-form") {
    clearInvitationResult();
    if (["clientUrl", "tunnelPort"].includes(event.target.name)) {
      clearTimeout(destinationTimer);
      destinationSequence++;
      destinationPreviews.delete(event.target.form);
      event.target.form.querySelector('[type="submit"]').disabled = true;
      destinationTimer = setTimeout(
        () => void previewDestination(event.target.form),
        180,
      );
    }
    return;
  }
  if (event.target.name !== "invitation" || !event.target.form) return;
  clearTimeout(previewTimer);
  invitationPreviews.delete(event.target.form);
  event.target.form.querySelector('[type="submit"]').disabled = true;
  previewSequence++;
  previewTimer = setTimeout(() => {
    void previewInvitation(event.target.form);
  }, 180);
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
  if (event.target.form?.id === "invite-form") {
    clearInvitationResult();
    if (event.target.name === "destination") {
      clearTimeout(destinationTimer);
      void previewDestination(event.target.form);
    }
  }
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
    Object.assign(setupState.providers[0], {
      vendor: "codex",
      authMode: "cli-session",
      connection: {
        source: "native-runtime",
        checkedAt: new Date().toISOString(),
        runtime: { name: "Codex CLI", version: "0.157.0" },
        account: {
          status: "signed-in",
          method: "ChatGPT",
          email: "details@example.invalid",
          name: "Synthetic Person",
          subscription: "Example plan",
        },
      },
    });
    setupState.setup = { version: 1, attempts: [] };
    const setupPanel = document.createElement("agenticdriver-providers");
    let pendingProvider,
      confirmations = 0;
    const check = (ok) => {
      if (!ok) throw new Error("Desktop UI regression.");
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
      check(root.textContent.includes("Codex CLI · 0.157.0"));
      check(root.textContent.includes("Example plan"));
      check(
        !root.innerHTML.includes("details@example.invalid") &&
          !root.innerHTML.includes("Synthetic Person"),
      );
      click('[data-action="reveal-account"]');
      check(
        root.textContent.includes("details@example.invalid") &&
          root.textContent.includes("Synthetic Person"),
      );
      click('[data-action="reveal-account"]');
      check(!root.innerHTML.includes("details@example.invalid"));
      const selectIcon = (field, value) => {
        const select = root.querySelector(`[data-field="${field}"]`);
        check(Boolean(select));
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      };
      selectIcon("icon-style", "monochrome");
      selectIcon("icon-variant", "openai");
      check(
        root
          .querySelector(".provider.selected svg")
          ?.outerHTML.includes("currentColor"),
      );
      click('[data-action="reveal-account"]');
      await setupPanel.refresh();
      check(!root.innerHTML.includes("details@example.invalid"));
      check(
        root.querySelector('[data-field="icon-variant"]').value === "openai",
      );
      check(
        !Object.keys(localStorage).some((key) =>
          /details@example.invalid|Synthetic Person/.test(
            localStorage.getItem(key),
          ),
        ),
      );
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
          !root.innerHTML.includes("renderer@example.invalid"),
      );
      const revealSetup = `.setup-attempts [data-action="reveal-account"]`;
      click(revealSetup);
      check(
        root
          .querySelector(".setup-attempts")
          .textContent.includes("renderer@example.invalid"),
      );
      click(revealSetup);
      check(!root.innerHTML.includes("renderer@example.invalid"));
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
      await setupPanel.refresh();
      selectIcon("icon-style", "monochrome");
      const availableTransport = setupPanel.transport;
      const selectedBeforeFailure = root.querySelector(
        '[data-action="select"][aria-pressed="true"]',
      ).dataset.id;
      const unavailableTransport = async (input) => {
        check(input.action === "snapshot");
        throw new Error("Synthetic host unavailable");
      };
      setupPanel.transport = unavailableTransport;
      await setupPanel.refresh();
      check(root.textContent.includes("Connection unavailable"));
      check(
        !root.querySelector(
          '[data-action="add"], [data-action="choose"], [data-action="enable"], [data-action="reveal-account"], [data-action="setup-accept"]',
        ),
      );
      check(!root.innerHTML.includes("details@example.invalid"));
      check(!root.querySelector('[data-action="connect"]'));
      check(!root.querySelector('[data-action="disconnect"]'));
      check(root.querySelector('[data-action="refresh"]'));
      setupPanel.transport = availableTransport;
      await setupPanel.refresh();
      check(!root.textContent.includes("Connection unavailable"));
      check(
        root.querySelector('[data-action="select"][aria-pressed="true"]')
          .dataset.id === selectedBeforeFailure,
      );
      check(
        root.querySelector('[data-field="icon-style"]').value === "monochrome",
      );
      check(!root.innerHTML.includes("details@example.invalid"));
      // A late error from an older refresh must not replace a newer successful view.
      let rejectOld;
      setupPanel.transport = () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        });
      const oldRefresh = setupPanel.refresh();
      await until(() => Boolean(rejectOld));
      setupPanel.transport = availableTransport;
      await setupPanel.refresh();
      rejectOld(new Error("Stale synthetic failure"));
      await oldRefresh;
      check(!root.textContent.includes("Connection unavailable"));
      check(!root.textContent.includes("Stale synthetic failure"));
      check(Boolean(root.querySelector('[data-action="add"]')));
      setupState.setup = {
        version: 1,
        attempts: [{ ...attempt, phase: "waiting" }],
      };
      setupPanel.transport = async (input) => {
        if (input.action === "setup" && input.request.action === "list")
          throw new Error("Synthetic sign-in poll unavailable");
        return availableTransport(input);
      };
      await setupPanel.refresh();
      await until(() => root.textContent.includes("Connection unavailable"));
      check(
        !root.querySelector(
          '[data-action="setup-accept"], [data-action="setup-cancel"]',
        ),
      );
      delete setupState.setup;
      setupPanel.transport = availableTransport;
      await setupPanel.refresh();
      const initiallyUnavailable = document.createElement(
        "agenticdriver-providers",
      );
      initiallyUnavailable.transport = unavailableTransport;
      document.body.append(initiallyUnavailable);
      try {
        await until(() =>
          initiallyUnavailable.shadowRoot.textContent.includes(
            "Connection unavailable",
          ),
        );
        check(
          Boolean(
            initiallyUnavailable.shadowRoot.querySelector(
              '[data-action="refresh"]',
            ),
          ),
        );
        check(
          !initiallyUnavailable.shadowRoot.querySelector(
            '[data-action="connect"]',
          ),
        );
        initiallyUnavailable.transport = async () => ({
          connected: false,
          providers: [],
          canConnect: true,
        });
        await initiallyUnavailable.refresh();
        check(
          Boolean(
            initiallyUnavailable.shadowRoot.querySelector(
              '[data-action="connect"]',
            ),
          ),
        );
        initiallyUnavailable.transport = async () => ({
          connected: true,
          providers: [],
          canDisconnect: true,
        });
        await initiallyUnavailable.refresh();
        initiallyUnavailable.transport = unavailableTransport;
        await initiallyUnavailable.refresh();
        check(
          Boolean(
            initiallyUnavailable.shadowRoot.querySelector(
              '[data-action="disconnect"]',
            ),
          ),
        );
        let disconnected = false;
        initiallyUnavailable.transport = async (input) => {
          check(input.action === "disconnect");
          disconnected = true;
          return { connected: false, providers: [], canConnect: true };
        };
        initiallyUnavailable.shadowRoot
          .querySelector('[data-action="disconnect"]')
          .click();
        await until(() =>
          Boolean(
            initiallyUnavailable.shadowRoot.querySelector(
              '[data-action="connect"]',
            ),
          ),
        );
        check(disconnected);
      } finally {
        initiallyUnavailable.remove();
      }
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
    check(
      liveRoot.querySelector("h3").textContent === "No providers configured",
    );
    check(
      liveRoot.textContent.includes("You have management access to this host."),
    );
    check(Boolean(liveRoot.querySelector('[data-action="add"]')));
    const emptyReadonly = document.createElement("agenticdriver-providers");
    emptyReadonly.transport = async () => ({
      connected: true,
      providers: [],
      canInvite: false,
      canDisconnect: false,
    });
    document.body.append(emptyReadonly);
    try {
      await until(() => emptyReadonly.shadowRoot.querySelector("h3"));
      check(
        emptyReadonly.shadowRoot.querySelector("h3").textContent ===
          "No providers granted",
      );
      check(!emptyReadonly.shadowRoot.querySelector('[data-action="add"]'));
      check(
        !emptyReadonly.shadowRoot.textContent.includes(
          "You have management access",
        ),
      );
    } finally {
      emptyReadonly.remove();
    }
    // Exercise the actual desktop forms against this isolated fixture host.
    // Fixture setup uses IPC; connection, checking, renaming and recovery use UI actions.
    const uiClick = async (selector) => {
      const button = document.querySelector(selector);
      check(button && !button.disabled);
      button.click();
      await until(() => !busy);
    };
    const uiSubmit = async (form) => {
      check(form.checkValidity());
      form.requestSubmit();
      await until(() => !busy);
    };
    const fillInvitation = (form, value) => {
      form.elements.invitation.value = value;
      form.elements.invitation.dispatchEvent(
        new Event("input", { bubbles: true }),
      );
    };
    const fitsViewport = () =>
      check(document.documentElement.scrollWidth <= window.innerWidth);
    const fixtureInvitation = () =>
      request({
        action: "invite",
        hostId: "local",
        input: {
          grant: {
            subject: "desktop-recovery-fixture",
            providers: [],
            manageProviders: true,
          },
        },
      });
    await uiClick('button[data-view="connections"]');
    let inviteForm = $("#invite-form");
    await until(() => !inviteForm.querySelector('[type="submit"]').disabled);
    inviteForm.elements.subject.value = "desktop-destination-fixture";
    inviteForm.elements.manage.checked = true;
    const chooseRoute = async (mode) => {
      inviteForm.elements.destination.value = mode;
      inviteForm.elements.destination.dispatchEvent(
        new Event("change", { bubbles: true }),
      );
    };
    await chooseRoute("https");
    await until(() =>
      inviteForm
        .querySelector(".destination-preview")
        .textContent.includes("Enter an absolute HTTPS"),
    );
    check(inviteForm.querySelector('[type="submit"]').disabled);
    inviteForm.elements.clientUrl.value =
      "https://driver.example.invalid/proxy/";
    inviteForm.elements.clientUrl.dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    await until(() => !inviteForm.querySelector('[type="submit"]').disabled);
    fitsViewport();
    await uiSubmit(inviteForm);
    check(
      $("#invitation-result").textContent.includes(
        "https://driver.example.invalid/proxy/",
      ),
    );
    check(
      $("#invitation-result").textContent.includes("route has not been tested"),
    );
    await chooseRoute("tunnel");
    check($("#invitation-result").hidden && !invitation);
    await until(() => !inviteForm.querySelector('[type="submit"]').disabled);
    inviteForm.querySelector(".tunnel-instructions").open = true;
    check(
      inviteForm
        .querySelector('[aria-label="Forward SSH tunnel command"]')
        .value.includes("-L 127.0.0.1:17433:127.0.0.1:"),
    );
    check(
      inviteForm
        .querySelector('[aria-label="Reverse SSH tunnel command"]')
        .value.includes("-R 127.0.0.1:17433:127.0.0.1:"),
    );
    fitsViewport();
    await uiSubmit(inviteForm);
    check(
      $("#invitation-result").textContent.includes("http://127.0.0.1:17433/"),
    );
    await chooseRoute("current");
    await until(() => !inviteForm.querySelector('[type="submit"]').disabled);
    await uiSubmit(inviteForm);
    const firstInvitation = { invitation };
    const nextInvitation = await fixtureInvitation();
    await uiClick('button[data-view="hosts"]');
    let form = $("#connect-form");
    fillInvitation(form, "incomplete-invitation");
    await until(() =>
      form
        .querySelector(".invitation-preview")
        .textContent.includes("Paste the complete"),
    );
    check(form.querySelector('[type="submit"]').disabled);
    fillInvitation(form, firstInvitation.invitation);
    await until(() => !form.querySelector('[type="submit"]').disabled);
    check(
      form
        .querySelector(".invitation-preview")
        .textContent.includes(overview.local.url),
    );
    check(
      !form
        .querySelector(".invitation-preview")
        .textContent.includes(firstInvitation.invitation),
    );
    check(
      (await request({ action: "connections", hostId: "local" })).connections
        .length === 0,
    );
    form.elements.label.value = "Synthetic workstation";
    fitsViewport();
    await uiSubmit(form);
    const remoteId = selected();
    check(remoteId !== "local" && overview.hosts.length === 1);
    check(overview.hosts[0].check.status === "connected");
    await uiClick('button[data-view="hosts"]');
    const settings = $(".host-options");
    settings.open = true;
    const nameForm = $(".rename-form");
    nameForm.elements.label.value = "Renamed workstation";
    nameForm.elements.label.focus();
    await api.pressSmokeEnter();
    await until(
      () => !busy && overview.hosts[0].label === "Renamed workstation",
    );
    check(
      $("#host-select").selectedOptions[0].textContent ===
        "Renamed workstation",
    );
    check(
      nameForm.closest(".host-row").querySelector("h2").textContent ===
        "Renamed workstation",
    );
    // Keep a real scoped preference record, and verify replacement uses the same scope.
    const preferenceKey = `agenticdriver.models.${remoteId}.synthetic-only`;
    const preferenceValue = JSON.stringify({
      favorites: ["synthetic-model"],
      hidden: [],
      order: [],
    });
    localStorage.setItem(preferenceKey, preferenceValue);
    await request({ action: "stop" });
    await uiClick(`[data-action="check-host"][data-host="${remoteId}"]`);
    check(
      $(`[data-host-status="${remoteId}"]`).textContent.includes("Unreachable"),
    );
    await uiClick(`[data-action="select"][data-host="${remoteId}"]`);
    await until(() =>
      $("agenticdriver-providers").shadowRoot.textContent.includes(
        "Open Hosts",
      ),
    );
    check(
      !$("agenticdriver-providers").shadowRoot.querySelector(
        '[data-action="add"]',
      ),
    );
    await request({ action: "start" });
    await uiClick('button[data-view="hosts"]');
    await uiClick(`[data-action="check-host"][data-host="${remoteId}"]`);
    check(
      $(`[data-host-status="${remoteId}"]`).textContent.includes(
        "Credential accepted",
      ),
    );
    const paired = (await request({ action: "connections", hostId: "local" }))
      .connections[0];
    await request({
      action: "revoke",
      hostId: "local",
      connectionId: paired.id,
    });
    await uiClick(`[data-action="check-host"][data-host="${remoteId}"]`);
    check(
      $(`[data-host-status="${remoteId}"]`).textContent.includes(
        "Access rejected",
      ),
    );
    $(".host-options").open = true;
    form = $(".reconnect-form");
    fillInvitation(form, nextInvitation.invitation);
    await until(() => !form.querySelector('[type="submit"]').disabled);
    fitsViewport();
    await uiSubmit(form);
    check(selected() === remoteId && overview.hosts.length === 1);
    check(overview.hosts[0].label === "Renamed workstation");
    check(overview.hosts[0].check.status === "connected");
    check(localStorage.getItem(preferenceKey) === preferenceValue);
    check(!$(".reconnect-form").elements.invitation.value);
    check(!document.body.innerHTML.includes(nextInvitation.invitation));
    check(
      $("#notification").textContent.includes("preferences were preserved"),
    );
    fitsViewport();
    await uiClick('[data-action="select"][data-host="local"]');
    await uiClick('button[data-view="connections"]');
    inviteForm = $("#invite-form");
    await chooseRoute("tunnel");
    await until(() => !inviteForm.querySelector('[type="submit"]').disabled);
    inviteForm.querySelector(".tunnel-instructions").open = true;
    inviteForm
      .querySelector(".destination-fields")
      .scrollIntoView({ block: "start" });
    fitsViewport();
    check(styleViolations.length === 0);
    await api.reportSmoke({
      providerSetupUi: true,
      providerDetailsUi: true,
      providerRemovalUi: true,
      remoteConnectionUi: true,
      invitationDestinationUi: true,
      panelRecoveryUi: true,
      keyboardUi: true,
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
    if (view === "hosts") refreshHostStatuses();
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

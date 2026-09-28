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
let renderedTunnels;
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
  return `<fieldset class="destination-fields"><legend>Where will the application backend connect?</legend><label class="field">Connection route<select name="destination"><option value="current">${hostId === "local" ? "On this computer" : "Use this host’s saved address"}</option><option value="https">Another computer · HTTPS</option>${hostId === "local" ? '<option value="managed-tunnel">Another computer · Managed SSH tunnel</option><option value="tunnel">Another computer · Manual SSH instructions</option>' : ""}</select></label><label class="field" data-destination-field="https" hidden>Reachable HTTPS address<input name="clientUrl" type="url" required disabled placeholder="https://driver.example.com/agenticdriver/" autocomplete="off"></label><label class="field" data-destination-field="tunnel" hidden>Loopback port beside the application backend<input name="tunnelPort" type="number" value="17433" min="1024" max="65535" required disabled></label>${hostId === "local" ? '<label class="field" data-destination-field="managed-tunnel" hidden>Saved SSH tunnel<select name="managedTunnelId" required disabled></select></label>' : ""}<div class="destination-preview" role="status"></div></fieldset>`;
}
function destinationInput(form) {
  const mode = form.elements.destination.value;
  return mode === "https"
    ? { mode, url: form.elements.clientUrl.value.trim() }
    : mode === "tunnel"
      ? { mode, port: Number(form.elements.tunnelPort.value) }
      : mode === "managed-tunnel"
        ? { mode, tunnelId: form.elements.managedTunnelId.value }
        : { mode };
}
async function previewDestination(form) {
  const input = destinationInput(form);
  const sequence = ++destinationSequence;
  destinationPreviews.delete(form);
  form.querySelector('[type="submit"]').disabled = true;
  for (const field of form.querySelectorAll("[data-destination-field]")) {
    field.hidden = field.dataset.destinationField !== input.mode;
    field.querySelector("input,select").disabled = field.hidden;
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
          : input.mode === "managed-tunnel"
            ? "OpenSSH accepted this tunnel. This loopback address is on the selected application server. Keep AgenticDriver open; the application still needs to complete pairing."
            : preview.url.startsWith("http:")
              ? "This loopback address reaches this computer. An application backend running elsewhere needs HTTPS or a tunnel."
              : "Applications must be able to reach this saved HTTPS address from their backend.";
    target.innerHTML = `<div class="notice"><strong>Invitation destination</strong><p class="address">${escape(preview.url)}</p><p>${description}</p>${preview.commands ? `<details class="tunnel-instructions"><summary>SSH setup instructions</summary><p>Choose one direction. Replace the capitalized destination with your existing SSH account and machine; keep that SSH session running.</p><label class="field">Run on the application backend machine<textarea readonly class="command" aria-label="Forward SSH tunnel command">${escape(preview.commands.fromApplication)}</textarea></label><p class="help">This direction needs SSH access from the application machine to this computer.</p><label class="field">Or run on this computer<textarea readonly class="command" aria-label="Reverse SSH tunnel command">${escape(preview.commands.fromHost)}</textarea></label><p class="help">This direction needs SSH access from this computer to the application server. Both recipes request a loopback listener; the SSH server must permit forwarding and honor that bind address.</p></details>` : ""}<p class="help">No route has been verified and no access has been issued. ${input.mode === "tunnel" ? "AgenticDriver does not start SSH or configure the server." : "Operator credentials are never sent to this preview address."}</p></div>`;
    destinationPreviews.set(form, JSON.stringify(input));
    form.querySelector('[type="submit"]').disabled = false;
  } catch {
    if (sequence !== destinationSequence || !form.isConnected) return;
    target.innerHTML = `<div class="notice warning"><p>${input.mode === "https" ? "Enter an absolute HTTPS address without credentials, a query string or a fragment." : input.mode === "tunnel" ? "Choose a loopback port between 1024 and 65535." : input.mode === "managed-tunnel" ? "Add and start an SSH tunnel above, then select it here. Saved routes do not connect automatically." : "Start the selected host before creating an invitation."}</p>${input.mode === "managed-tunnel" ? '<button type="button" class="button" data-action="show-tunnel-setup">Set up SSH tunnel</button>' : ""}</div>`;
  }
}
function tunnelCard() {
  return `<div class="card" id="tunnel-card"><div class="card-head"><div><h2>SSH tunnels</h2><p class="muted">Let an application server reach this computer through your existing SSH access. Start a tunnel here, then use it for an invitation below.</p></div><span class="badge">Outbound · Linux</span></div><div id="tunnel-list"></div><details class="host-options" id="tunnel-setup"><summary>Add an SSH tunnel</summary><form id="tunnel-form" class="stack"><div class="fields"><label class="field">Name<input name="label" required maxlength="80" placeholder="My LitAgent server" autocomplete="off"></label><label class="field">SSH destination<input name="target" required maxlength="200" placeholder="my-server or user@server" autocomplete="off" spellcheck="false"></label><label class="field">Application server port<input name="remotePort" type="number" value="17433" min="1024" max="65535" required></label></div><p class="help">Use a destination you can already reach with SSH without a password prompt. Its host key must already be trusted. The server must permit loopback forwarding. Keys and SSH settings stay on this computer.</p><div><button type="submit" class="button">Save tunnel</button><button type="button" class="button quiet" data-action="cancel-tunnel-edit" hidden>Cancel editing</button></div></form></details><p class="help">Saving does not connect. Starting opens only the selected route; applications still need a scoped invitation. Stopping a tunnel does not revoke their access.</p></div>`;
}
function resetTunnelForm() {
  const form = $("#tunnel-form");
  form.reset();
  delete form.dataset.tunnel;
  form.querySelector('[type="submit"]').textContent = "Save tunnel";
  form.querySelector('[data-action="cancel-tunnel-edit"]').hidden = true;
}
function renderTunnelList() {
  const list = $("#tunnel-list");
  if (!list) return;
  const tunnels = overview.tunnels ?? [];
  const signature = JSON.stringify(tunnels);
  if (signature === renderedTunnels) return;
  renderedTunnels = signature;
  list.innerHTML =
    tunnels
      .map(
        (t) =>
          `<div class="tunnel-entry"><div class="connection-row"><div><strong>${escape(t.label)}</strong><div class="connection-details"><span class="badge ${t.status === "running" ? "green" : t.status === "failed" ? "amber" : ""}">${escape(t.status[0].toUpperCase() + t.status.slice(1))}</span><span class="address">${escape(t.target)} · ${escape(t.url)}</span></div><p class="help">${t.status === "running" ? "SSH forwarding is active. Application pairing and provider access are checked separately." : t.status === "starting" ? "Connecting with your existing SSH sign-in…" : t.status === "stopped" ? "Start when needed. This tunnel will not reconnect automatically." : escape(t.message)}</p></div><div class="host-actions">${t.status === "running" ? `<button class="button" data-action="use-tunnel" data-tunnel="${t.id}">Use for invitation</button>` : ""}<button class="button ${t.status === "running" ? "quiet" : "primary"}" data-action="${t.status === "running" ? "stop-tunnel" : "start-tunnel"}" data-tunnel="${t.id}" ${t.status === "starting" || !overview.local.running ? "disabled" : ""}>${t.status === "running" ? "Stop tunnel" : t.status === "starting" ? "Starting…" : "Start tunnel"}</button><button class="button quiet" data-action="edit-tunnel" data-tunnel="${t.id}" ${["starting", "running"].includes(t.status) ? "disabled" : ""}>Edit</button><button class="button quiet" data-action="forget-tunnel" data-tunnel="${t.id}" ${t.status === "starting" ? "disabled" : ""}>Remove</button></div></div><div class="notice warning" data-tunnel-confirm="${t.id}" hidden></div></div>`,
      )
      .join("") ||
    '<p class="muted">No saved tunnels. Local and HTTPS connections work without one.</p>';
  const form = $("#invite-form");
  const select = form?.elements.managedTunnelId;
  if (select) {
    const chosen = select.value;
    select.innerHTML =
      '<option value="">Choose a running tunnel</option>' +
      tunnels
        .map(
          (t) =>
            `<option value="${t.id}" ${t.status !== "running" ? "disabled" : ""}>${escape(t.label)} · ${escape(t.status)}</option>`,
        )
        .join("");
    select.value = tunnels.some((t) => t.id === chosen) ? chosen : "";
    if (form.elements.destination.value === "managed-tunnel") {
      clearInvitationResult();
      void previewDestination(form);
    }
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
      ${hostId === "local" ? tunnelCard() : ""}
      <div class="card"><div class="card-head"><div><h2>Connect a new application</h2><p class="muted">Create an invitation, then paste it into the application’s AgenticDriver settings.</p></div><span class="badge">One use · 10 minutes</span></div><form id="invite-form" class="stack"><label class="field">Application name<input name="subject" required maxlength="128" placeholder="LitAgent, Brandstorm, AI Workspace…"></label>${invitationDestinationFields(hostId)}<fieldset><legend>Provider access</legend><div class="provider-checks">${providers.map((p) => `<label class="check"><input type="checkbox" name="provider" value="${escape(p.id)}" checked><span>${escape(p.name || p.id)} <small class="muted">${escape(p.kind)}</small></span></label>`).join("") || '<p class="muted">Add a provider first, or create a management-only invitation.</p>'}</div></fieldset><div class="fields"><label class="field">Connection lifetime<select name="lifetime"><option value="86400">1 day</option><option value="604800">7 days</option><option value="2592000" selected>30 days</option><option value="7776000">90 days</option></select></label><label class="check"><input type="checkbox" name="manage"><span>Allow provider management<br><small class="muted">Can edit providers and issue or revoke connection grants.</small></span></label></div><div><button class="button primary" type="submit" disabled>Create invitation</button></div></form><div id="invitation-result" hidden></div></div>`;
    renderConnectionList();
    renderedTunnels = undefined;
    renderTunnelList();
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
    if (act === "show-tunnel-setup") {
      $("#tunnel-setup").open = true;
      $("#tunnel-card").scrollIntoView({ block: "start" });
      $("#tunnel-form").elements.label.focus();
    } else if (act === "cancel-tunnel-edit") {
      resetTunnelForm();
    } else if (act === "edit-tunnel") {
      const tunnel = overview.tunnels.find(
        (item) => item.id === button.dataset.tunnel,
      );
      const form = $("#tunnel-form");
      form.dataset.tunnel = tunnel.id;
      for (const key of ["label", "target", "remotePort"])
        form.elements[key].value = tunnel[key];
      form.querySelector('[type="submit"]').textContent = "Save changes";
      form.querySelector('[data-action="cancel-tunnel-edit"]').hidden = false;
      $("#tunnel-setup").open = true;
      form.scrollIntoView({ block: "start" });
      form.elements.label.focus();
      notice(
        "Edit this stopped route. A changed server or port needs a new invitation in the application.",
      );
    } else if (act === "use-tunnel") {
      const form = $("#invite-form");
      form.elements.destination.value = "managed-tunnel";
      form.elements.managedTunnelId.value = button.dataset.tunnel;
      clearInvitationResult();
      await previewDestination(form);
      form.scrollIntoView({ block: "start" });
      form.elements.subject.focus();
    } else if (
      [
        "start-tunnel",
        "stop-tunnel",
        "forget-tunnel",
        "interrupt-tunnel",
      ].includes(act)
    ) {
      const operation =
        act === "interrupt-tunnel" ? button.dataset.operation : act;
      const tunnelId = button.dataset.tunnel;
      if (
        operation === "forget-tunnel" &&
        act !== "interrupt-tunnel" &&
        button.dataset.confirm !== "yes"
      ) {
        button.dataset.confirm = "yes";
        button.textContent = "Confirm removal";
        notice(
          "Remove this saved tunnel and stop its SSH session. Application grants will remain unchanged.",
        );
        return;
      }
      button.disabled = true;
      if (operation === "start-tunnel") button.textContent = "Starting…";
      try {
        overview = await request({
          action: operation,
          tunnelId,
          ...(operation === "start-tunnel"
            ? {}
            : { interrupt: act === "interrupt-tunnel" }),
        });
        if (
          operation === "forget-tunnel" &&
          $("#tunnel-form").dataset.tunnel === tunnelId
        )
          resetTunnelForm();
        notice(
          operation === "start-tunnel"
            ? "SSH tunnel running. Choose Use for invitation to connect your application."
            : "Tunnel stopped. Existing application grants were not revoked.",
        );
      } catch (error) {
        if (error.code === "TUNNEL_BUSY") {
          const confirm = $(`[data-tunnel-confirm="${tunnelId}"]`);
          confirm.hidden = false;
          confirm.innerHTML = `<p>The local host has active requests. Stopping this tunnel may interrupt them.</p><button class="button danger" data-action="interrupt-tunnel" data-operation="${operation}" data-tunnel="${tunnelId}">Stop tunnel and interrupt its traffic</button>`;
          return;
        }
        throw error;
      } finally {
        button.disabled = false;
        await refreshOverview();
        renderTunnelList();
      }
    } else if (act === "start" || act === "stop" || act === "interrupt") {
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
    !["connect-form", "invite-form", "usage-form", "tunnel-form"].includes(
      form.id,
    ) &&
    !form.matches(".reconnect-form,.rename-form")
  )
    return;
  event.preventDefault();
  const data = new FormData(form);
  const hostId = selected();
  void action(async () => {
    if (form.id === "tunnel-form") {
      overview = await request({
        action: form.dataset.tunnel ? "update-tunnel" : "create-tunnel",
        ...(form.dataset.tunnel ? { tunnelId: form.dataset.tunnel } : {}),
        input: {
          label: data.get("label"),
          target: data.get("target"),
          remotePort: Number(data.get("remotePort")),
        },
      });
      resetTunnelForm();
      $("#tunnel-setup").open = false;
      renderTunnelList();
      notice(
        "Tunnel saved. Start it when you are ready to connect to that SSH server.",
      );
    } else if (form.id === "connect-form" || form.matches(".reconnect-form")) {
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
    if (["destination", "managedTunnelId"].includes(event.target.name)) {
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
      renderTunnelList();
    } else await show(view);
  });
});
try {
  await refreshOverview();
  await show("providers");
} catch (error) {
  notice(error.message, true);
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
        renderTunnelList();
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

/** Explicit opt-in remote transport check. Only a temporary mock host and loopback SSH forwarding. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopController } from "../src/controller.mjs";

const target = process.argv[2];
if (!target || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,199}$/.test(target))
  throw new Error(
    "Select an existing SSH host alias or user@host explicitly. The remote machine needs Python 3.",
  );
const sshOptions = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ControlPath=none",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ForwardAgent=no",
  "-o",
  "PermitLocalCommand=no",
  "-o",
  "ClearAllForwardings=yes",
];
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
const directory = await mkdtemp(join(tmpdir(), "agenticdriver-ssh-"));
let host, tunnelId;
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const ended = once(child, "exit");
  child.kill("SIGTERM");
  const fallback = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    await ended;
  } finally {
    clearTimeout(fallback);
  }
}
const remoteScript = `
import base64, json, sys, urllib.request, urllib.error, urllib.parse
invitation = json.load(sys.stdin)
prefix, encoded, code = invitation.split('.')
assert prefix == 'ad1'
base = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)).decode()
assert base.startswith('http://127.0.0.1:') and base.endswith('/')
loopback_verified = None
if sys.platform.startswith('linux'):
    port = urllib.parse.urlsplit(base).port
    listeners = []
    for path in ('/proc/net/tcp', '/proc/net/tcp6'):
        with open(path) as sockets:
            for line in list(sockets)[1:]:
                fields = line.split()
                address, raw_port = fields[1].split(':')
                if fields[3] == '0A' and int(raw_port, 16) == port:
                    listeners.append(address)
    assert listeners and all(address in ('0100007F', '00000000000000000000000001000000') for address in listeners)
    loopback_verified = True
def request(path, token, method='GET'):
    req = urllib.request.Request(base + path, headers={'Authorization': 'Bearer ' + token, 'AgenticDriver-Version': '1.0', 'Content-Type': 'application/json'}, data=b'{}' if method == 'POST' else None, method=method)
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)
credentials = request('v1/connections/exchange', code, 'POST')
protocol = request('v1/protocol', credentials['token'])
providers = request('v1/providers', credentials['token'])
assert protocol['protocol'] == 'agenticdriver' and protocol['version'] == '1.0'
assert [p['id'] for p in providers['providers']] == ['ssh-fixture']
try:
    request('v1/connections/exchange', code, 'POST')
    raise AssertionError('An invitation must not be replayable')
except urllib.error.HTTPError as error:
    assert error.code in (401, 403)
print(json.dumps({'connectionId': credentials['id'], 'protocol': protocol['version'], 'providerIds': [p['id'] for p in providers['providers']], 'replayRejected': True, 'loopbackBindVerified': loopback_verified}))
`;
try {
  host = await desktopController(directory);
  const snapshot = await host.request({
    action: "panel",
    hostId: "local",
    request: { action: "snapshot" },
  });
  await host.request({
    action: "panel",
    hostId: "local",
    request: {
      action: "configure",
      change: {
        revision: snapshot.management.revision,
        provider: {
          kind: "mock",
          id: "ssh-fixture",
          accountId: "synthetic-only",
        },
      },
    },
  });
  const requestedPort = process.argv[3];
  let remotePort;
  if (requestedPort !== undefined) {
    remotePort = Number(requestedPort);
    assert.ok(
      Number.isInteger(remotePort) && remotePort >= 1024 && remotePort <= 65535,
    );
  } else {
    // Test-only free-port selection. Production always uses the saved explicit port.
    const probe =
      "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()";
    const result = await promisify(execFile)(
      "ssh",
      [...sshOptions, target, `python3 -c ${quote(probe)}`],
      { timeout: 15000, maxBuffer: 1024 },
    );
    remotePort = Number(result.stdout.trim());
    assert.ok(
      Number.isInteger(remotePort) && remotePort >= 1024 && remotePort <= 65535,
    );
  }
  const configured = await host.request({
    action: "create-tunnel",
    input: { label: "Synthetic remote transport", target, remotePort },
  });
  tunnelId = configured.tunnels[0].id;
  const started = await host.request({ action: "start-tunnel", tunnelId });
  assert.equal(started.tunnels[0].status, "running");
  const invitation = await host.request({
    action: "invite",
    hostId: "local",
    destination: { mode: "managed-tunnel", tunnelId },
    input: {
      grant: { subject: "ssh-metadata-fixture", providers: ["ssh-fixture"] },
      connectionLifetimeSeconds: 60,
    },
  });
  const child = spawn(
    "ssh",
    [...sshOptions, target, `python3 -c ${quote(remoteScript)}`],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (bytes) => {
    output = (output + bytes).slice(-8192);
  });
  // Runtime diagnostics may include addresses; never print bodies or credentials.
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const timeout = setTimeout(() => child.kill("SIGTERM"), 30000);
  let result;
  try {
    const finished = once(child, "exit");
    child.stdin.end(JSON.stringify(invitation.invitation));
    const [exitCode] = await finished;
    assert.equal(exitCode, 0, "The remote metadata check did not pass.");
    result = JSON.parse(output);
    assert.deepEqual(result.providerIds, ["ssh-fixture"]);
    assert.equal(result.replayRejected, true);
  } finally {
    clearTimeout(timeout);
    await stop(child);
  }
  await host.request({
    action: "revoke",
    hostId: "local",
    connectionId: result.connectionId,
  });
  assert.equal(
    (await host.request({ action: "connections", hostId: "local" })).connections
      .length,
    0,
  );
  await host.request({ action: "stop-tunnel", tunnelId });
  assert.equal(
    (await host.request({ action: "overview" })).tunnels[0].status,
    "stopped",
  );
  await host.close();
  host = undefined;
  console.log(
    JSON.stringify({
      sshTransport: "passed",
      desktopManaged: true,
      target,
      protocol: result.protocol,
      providerIds: result.providerIds,
      invitationReplayRejected: true,
      temporaryGrantRevoked: true,
      tunnelClosed: true,
      loopbackBindVerified: result.loopbackBindVerified,
      modelCalls: 0,
      sshHostKeyVerification: true,
    }),
  );
} finally {
  await host?.close({ interrupt: true });
  await rm(directory, { recursive: true, force: true });
}

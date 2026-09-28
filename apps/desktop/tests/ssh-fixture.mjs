import { spawn, execFile as execute } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { access, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const execFile = promisify(execute);

export async function available() {
  if (process.platform !== "linux") return false;
  try {
    await access("/usr/sbin/sshd");
    await access("/usr/bin/ssh");
    return true;
  } catch {
    return false;
  }
}
export async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error("Synthetic SSH state did not settle.");
}
export async function sshFixture() {
  const directory = await mkdtemp(join(tmpdir(), "driver-sshd-"));
  const port = await freePort();
  const ambientPort = await freePort();
  const key = join(directory, "identity");
  const hostKey = join(directory, "host");
  const knownHosts = join(directory, "known-hosts");
  const configFile = join(directory, "ssh-config");
  const forbidden = join(directory, "unrequested-command");
  let server;
  async function close() {
    if (server && server.exitCode === null && server.signalCode === null) {
      const done = once(server, "exit");
      server.kill("SIGTERM");
      await done;
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    for (const file of [key, hostKey])
      await execFile("/usr/bin/ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        file,
      ]);
    await writeFile(
      join(directory, "authorized-keys"),
      await readFile(key + ".pub"),
      { mode: 0o600 },
    );
    await writeFile(
      knownHosts,
      `[127.0.0.1]:${port} ${await readFile(hostKey + ".pub", "utf8")}`,
      { mode: 0o600 },
    );
    const daemonConfig = join(directory, "sshd-config");
    await writeFile(
      daemonConfig,
      `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${directory}/pid\nAuthorizedKeysFile ${directory}/authorized-keys\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\nAllowUsers ${userInfo().username}\nAllowTcpForwarding remote\nGatewayPorts no\nLogLevel ERROR\n`,
      { mode: 0o600 },
    );
    await writeFile(
      configFile,
      `Host synthetic\n HostName 127.0.0.1\n Port ${port}\n User ${userInfo().username}\n IdentityFile ${key}\n IdentitiesOnly yes\n UserKnownHostsFile ${knownHosts}\n GlobalKnownHostsFile /dev/null\n LocalForward 127.0.0.1:${ambientPort} 127.0.0.1:1\n PermitLocalCommand yes\n LocalCommand touch ${forbidden}\n RemoteCommand touch ${forbidden}\n ForwardAgent yes\n ForwardX11 yes\n`,
      { mode: 0o600 },
    );
    server = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", daemonConfig], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostic = "";
    server.stderr.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-2048);
    });
    await delay(150);
    if (server.exitCode !== null)
      throw new Error("Synthetic sshd could not start: " + diagnostic);
    return { directory, configFile, knownHosts, forbidden, ambientPort, close };
  } catch (error) {
    await close();
    throw error;
  }
}

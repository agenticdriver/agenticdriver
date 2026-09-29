"""Inspect two explicitly provisioned, disposable real-account deployments.

Run on the execution computer. The private manifest selects existing container
IDs, their proxy IDs, kind (codex/claude), model and local private runtime base.
No credentials are loaded into images or command-line arguments. --execute sends
one meaningful request and one explicit cancellation per account. --allow-stop
authorizes stopping/restarting only these selected disposable containers.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accounts", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--docker-container", help="Optional existing Docker-in-Docker engine")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--allow-stop", required=True, action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    output = os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w")
    accounts = json.loads(args.accounts.read_text())
    assert len(accounts) == 2 and {a["kind"] for a in accounts} == {"codex", "claude"}
    assert len({a["container"] for a in accounts}) == 2
    expected = {"codex": "gpt-6-luna", "claude": "claude-haiku-4-5-20251001"}
    assert all(a["model"] == expected[a["kind"]] for a in accounts)
    docker = (["docker", "exec", "-i", args.docker_container] if args.docker_container else []) + ["docker"]
    receipt = {"schema": "agenticdriver.real-account-isolation.v1", "status": "failed",
               "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "modelRequests": 0, "checks": {}, "containers": [], "runs": [],
               "limitations": ["Trusted operator and shared Linux kernel; no hostile-kernel escape claim.",
                               "Whole-container shutdown, not SDK process-group cancellation, removes deliberately detached processes.",
                               "No macOS or Windows qualification."]}
    restart = set()

    def run(command, data=None):
        result = subprocess.run(docker + command, input=data, capture_output=True, text=True)
        if result.returncode:
            # Native diagnostics may contain account information. Keep errors private.
            receipt["diagnostic"] = result.stderr[-4000:]
            raise RuntimeError("Selected container check failed; inspect the private receipt.")
        return result.stdout.strip()

    def inspect(account):
        return json.loads(run(["inspect", account["container"]]))[0]

    def js(account, script, data=None):
        return run(["exec", "-i", "-e", "NODE_EXTRA_CA_CERTS=/etc/agenticdriver/ca.crt",
                    account["container"], "node", "--input-type=module", "-e", script], data)

    def qualify(account, mode):
        return json.loads(run(["exec", "-e", "NODE_EXTRA_CA_CERTS=/etc/agenticdriver/ca.crt",
                               account["container"], "node", "/etc/agenticdriver/qualify.mjs", mode, account["model"]]))

    try:
        for account in accounts:
            info = inspect(account)
            controls = info["HostConfig"]
            assert info["State"]["Running"] and info["Config"]["User"] == "1000:1000"
            assert controls["ReadonlyRootfs"] and not controls["Privileged"]
            assert controls["CapDrop"] == ["ALL"] and "no-new-privileges:true" in controls["SecurityOpt"]
            assert controls["PidsLimit"] == 256 and controls["Memory"] == 1073741824
            assert controls["PidMode"] != "host" and controls["NetworkMode"] == "container:" + account["proxy"]
            assert controls["RestartPolicy"]["Name"] == "no"
            assert set(controls["Tmpfs"]) == {"/tmp"} and "size=128m" in controls["Tmpfs"]["/tmp"]
            assert {m["Destination"] for m in info["Mounts"]} == {
                "/etc/agenticdriver", "/run/secrets", "/home/node", "/var/lib/agenticdriver"}
            assert all(not m["RW"] for m in info["Mounts"] if m["Type"] == "bind")
            receipt["containers"].append({"kind": account["kind"], "image": info["Image"],
                "volumes": [m["Name"] for m in info["Mounts"] if m["Type"] == "volume"],
                "pidNamespace": run(["exec", account["container"], "readlink", "/proc/self/ns/pid"]),
                "probe": qualify(account, "probe"), "catalog": qualify(account, "catalog")})
        first, second = receipt["containers"]
        assert first["pidNamespace"] != second["pidNamespace"]
        assert not set(first["volumes"]) & set(second["volumes"])
        receipt["checks"]["separateNamespacesAndVolumes"] = True

        if args.execute:
            for account in accounts:
                for mode in ["run", "cancel"]:
                    receipt["modelRequests"] += 1
                    receipt["runs"].append(qualify(account, mode))
                    if mode == "cancel":
                        # Cleanup grace for observation; no generation timeout is configured.
                        time.sleep(4)
                receipt["checks"][account["kind"] + "CancellationCleanup"] = qualify(account, "probe")

        for index, account in enumerate(accounts):
            other = accounts[1 - index]
            token = (Path(other["base"]) / "runtime/secrets/driver-token").read_text()
            js(account, '''const chunks=[];for await(const c of process.stdin)chunks.push(c);
const r=await fetch("https://127.0.0.1:8443/v1/providers",{headers:{Authorization:"Bearer "+Buffer.concat(chunks).toString().trim()}});
if(r.status!==401)throw Error("Other account credential was not rejected");''', token)
            receipt["checks"][account["kind"] + "OtherTokenRejected"] = True
            js(account, '''import{spawn}from"node:child_process";import{writeFile}from"node:fs/promises";
await writeFile("/tmp/isolated-lifecycle-marker","private temporary context");
await writeFile("/var/lib/agenticdriver/lifecycle-marker","persistent account state");
const c=spawn(process.execPath,["-e","process.title='driver-escape-probe';process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});c.unref();''')
            time.sleep(0.2)
            escaped = [line.split()[0] for line in run(["top", account["container"], "-eo", "pid,args"]).splitlines()
                       if "driver-escape-probe" in line]
            assert escaped and all(pid.isdigit() for pid in escaped)
            restart.add(account["container"])
            run(["stop", "-t", "2", account["container"]])
            assert not inspect(account)["State"]["Running"] and inspect(other)["State"]["Running"]
            for pid in escaped:
                command = (["docker", "exec", args.docker_container] if args.docker_container else []) + ["cat", f"/proc/{pid}/cmdline"]
                observed = subprocess.run(command, capture_output=True).stdout
                assert b"driver-escape-probe" not in observed
            receipt["checks"][account["kind"] + "DetachedProcessStopped"] = True
            run(["start", account["container"]])
            restart.remove(account["container"])
            time.sleep(2)
            js(account, '''import{access,readFile}from"node:fs/promises";import assert from"node:assert/strict";
await assert.rejects(access("/tmp/isolated-lifecycle-marker"));
assert.equal(await readFile("/var/lib/agenticdriver/lifecycle-marker","utf8"),"persistent account state");''')
            receipt["checks"][account["kind"] + "CatalogAfterRestart"] = qualify(account, "catalog")
            receipt["checks"][account["kind"] + "StopRestartBoundary"] = True
        receipt["status"] = "passed"
    finally:
        for container in restart:
            subprocess.run(docker + ["start", container], capture_output=True)
        receipt["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        json.dump(receipt, output, indent=2)
        output.write("\n")
        output.close()
    print(json.dumps({"status": receipt["status"], "modelRequests": receipt["modelRequests"],
                      "receipt": str(args.output)}))


if __name__ == "__main__":
    main()

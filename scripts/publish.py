"""Prepare a verified CI candidate for one registry; uploads are explicit workflow steps.

Only publish-go mutates a remote. It creates a missing immutable tag, never
replaces one. All other operations inspect, download, compare or package files.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

from release import ROOT, archive_files, run, sha256, verify


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def public_read(url, *, missing_ok=False, limit=64 * 1024 * 1024):
    request = urllib.request.Request(url, headers={"User-Agent": "agenticdriver-release/0.1"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            body = response.read(limit + 1)
            if len(body) > limit:
                raise ValueError("Registry response exceeds the release limit")
            return body
    except urllib.error.HTTPError as error:
        error.close()
        if error.code == 404 and missing_ok:
            return None
        raise ValueError(f"Registry lookup failed with HTTP {error.code}; do not assume absence") from None


def public_json(url):
    body = public_read(url, missing_ok=True, limit=4 * 1024 * 1024)
    return None if body is None else json.loads(body)


def github(path, data=None, missing_ok=False):
    args = ["gh", "api", "--hostname", "github.com", path]
    if data is not None:
        args += ["--method", "POST", "--input", "-"]
    result = subprocess.run(args, input=None if data is None else json.dumps(data),
                            text=True, capture_output=True, check=False)
    if result.returncode:
        # gh's structured REST error distinguishes a missing ref from auth/outage.
        try:
            status = json.loads(result.stdout).get("status")
        except (ValueError, AttributeError):
            status = None
        if str(status) == "404" and missing_ok:
            return None
        raise ValueError("GitHub API operation failed; no retry or absence assumed")
    return json.loads(result.stdout)


def validate_ci(record, repository, commit):
    if (record.get("status") != "completed" or record.get("conclusion") != "success"
            or record.get("event") not in {"push", "workflow_dispatch"}
            or record.get("path") != ".github/workflows/ci.yml"
            or record.get("head_sha") != commit
            or record.get("repository", {}).get("full_name") != repository
            or record.get("head_repository", {}).get("full_name") != repository):
        raise ValueError("Release requires successful SDK CI for this exact repository and commit")


def validate_candidate(manifest, config, commit):
    if manifest["repository"] != config["repository"] or manifest["commit"] != commit or manifest["dirty"]:
        raise ValueError("Candidate must be clean and belong to the reviewed source commit")
    if manifest["protocolVersion"] != config["protocolVersion"]:
        raise ValueError("Candidate protocol differs from the release configuration")
    for registry, name in config["names"].items():
        if manifest["packages"][registry]["name"] != name:
            raise ValueError("Candidate package identity differs from the release configuration")
        version = manifest["packages"][registry]["version"]
        expected = ("v" if registry == "go" else "") + r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
        if re.fullmatch(expected, version) is None:
            raise ValueError("Unsupported release version")
    if "goVersion" in config and manifest["packages"]["go"]["version"] != "v" + config["goVersion"]:
        raise ValueError("Candidate Go version differs from the release configuration")


def pending_files(bundle, manifest, registry):
    """Return missing artifacts only; an existing mismatch aborts the whole upload."""
    package = manifest["packages"][registry]
    name, version = package["name"], package["version"]
    if registry == "npm":
        remote = public_json(f"https://registry.npmjs.org/{urllib.parse.quote(name, safe='')}/{version}")
        if remote is None:
            return [package["archive"]]
        integrity = "sha512-" + base64.b64encode(hashlib.sha512((bundle / package["archive"]).read_bytes()).digest()).decode()
        if (remote.get("name"), remote.get("version"), remote.get("dist", {}).get("integrity")) != (name, version, integrity):
            raise ValueError("Existing npm version differs from the reviewed artifact")
        return []
    if registry == "python":
        expected = [package["wheel"], package["sdist"]]
        remote = public_json(f"https://pypi.org/pypi/{name}/{version}/json")
        if remote is None:
            return expected
        if remote.get("info", {}).get("name") != name or remote["info"].get("version") != version:
            raise ValueError("Unexpected PyPI package identity")
        files = {item["filename"]: item for item in remote["urls"]}
        if len(files) != len(remote["urls"]) or set(files) - {Path(path).name for path in expected}:
            raise ValueError("Unexpected existing PyPI files")
        missing = []
        for path in expected:
            existing = files.get(Path(path).name)
            if existing is None:
                missing.append(path)
            elif existing.get("digests", {}).get("sha256") != sha256(bundle / path):
                raise ValueError("Existing PyPI file differs from the reviewed artifact")
        return missing
    if registry == "rust":
        remote = public_json(f"https://crates.io/api/v1/crates/{name}/{version}")
        if remote is None:
            return [package["archive"]]
        entry = remote.get("version", {})
        if entry.get("crate") != name or entry.get("num") != version or entry.get("yanked"):
            raise ValueError("Unexpected or yanked crates.io version")
        if entry.get("checksum") != sha256(bundle / package["archive"]):
            # Cargo may normalize archive headers. Every packaged file must match.
            body = public_read(f"https://static.crates.io/crates/{name}/{name}-{version}.crate")
            if hashlib.sha256(body).hexdigest() != entry.get("checksum"):
                raise ValueError("crates.io download differs from registry checksum")
            with tempfile.TemporaryDirectory(prefix="agenticdriver-crate-compare-") as directory:
                archive = Path(directory) / "remote.crate"
                archive.write_bytes(body)
                if archive_files(archive) != archive_files(bundle / package["archive"]):
                    raise ValueError("Existing crate contents differ from the reviewed artifact")
        return []
    if registry == "go":
        tag = "clients/go/" + version
        remote = github(f"repos/{manifest['repository']}/git/ref/tags/{tag}", missing_ok=True)
        if remote is None:
            return [tag]
        if remote.get("object", {}).get("type") != "commit" or remote["object"].get("sha") != manifest["commit"]:
            raise ValueError("Existing Go tag does not point directly at the reviewed commit; never replace it")
        return []
    raise ValueError("Unknown registry")


def prepare_crate(bundle, manifest, directory):
    package = manifest["packages"]["rust"]
    for name, body in archive_files(bundle / package["archive"]).items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    source = directory / f"{package['name']}-{package['version']}"
    # Restore Cargo's author manifest, so repackaging retains Cargo.toml.orig.
    shutil.copyfile(source / "Cargo.toml.orig", source / "Cargo.toml")
    return source


def prepare(run_id, registry, output):
    if re.fullmatch(r"[1-9][0-9]*", run_id) is None:
        raise ValueError("CI run ID must be numeric")
    config = json.loads((ROOT / "release/config.json").read_text())
    commit = run(["git", "rev-parse", "HEAD"])
    record = github(f"repos/{config['repository']}/actions/runs/{run_id}")
    validate_ci(record, config["repository"], commit)
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    bundle = output / "bundle"
    run(["gh", "run", "download", run_id, "--repo", config["repository"],
         "--name", "agenticdriver-candidate-" + commit, "--dir", str(bundle)])
    manifest = verify(bundle, require_clean=True)
    validate_candidate(manifest, config, commit)
    pending = pending_files(bundle, manifest, registry)
    upload = output / "upload"
    upload.mkdir()
    if registry != "go":
        for path in pending:
            shutil.copyfile(bundle / path, upload / Path(path).name)
    source = prepare_crate(bundle, manifest, output / "cargo") if registry == "rust" and pending else None
    receipt = {"registry": registry, "commit": commit, "ciRun": run_id,
               "pending": pending, "bundle": str(bundle), "upload": str(upload),
               "cargoSource": str(source) if source else None}
    (output / "publication.json").write_text(json.dumps(receipt, indent=2) + "\n")
    values = {"pending": str(bool(pending)).lower(), "bundle": str(bundle), "upload": str(upload),
              "npm_archive": str(bundle / manifest["packages"]["npm"]["archive"]),
              "cargo_source": str(source) if source else "", "epoch": str(manifest["sourceDateEpoch"])}
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            for key, value in values.items():
                if "\n" in value or "\r" in value:
                    raise ValueError("Invalid workflow output")
                stream.write(f"{key}={value}\n")
    print(json.dumps(receipt))


def check_crate(bundle, source):
    manifest = verify(bundle, require_clean=True)
    source = Path(source).resolve()
    target = source.parent / "target"
    env = {**os.environ, "CARGO_TARGET_DIR": str(target), "SOURCE_DATE_EPOCH": str(manifest["sourceDateEpoch"])}
    run(["cargo", "+1.89.0", "package", "--locked", "--manifest-path", str(source / "Cargo.toml")], source, env)
    expected = Path(bundle) / manifest["packages"]["rust"]["archive"]
    packed = target / "package" / expected.name
    if archive_files(packed) != archive_files(expected):
        raise ValueError("Cargo repackaging changed reviewed contents")
    print(json.dumps({"cargoArchive": str(packed), "sha256": sha256(packed), "contentsMatch": True}))


def check_registry(bundle, registry):
    bundle = Path(bundle).resolve()
    manifest = verify(bundle, require_clean=True)
    if pending_files(bundle, manifest, registry):
        raise ValueError("Registry publication is not complete")
    print(json.dumps({"registry": registry, "version": manifest["packages"][registry]["version"], "verified": True}))


def publish_go(bundle, run_id):
    bundle = Path(bundle).resolve()
    manifest = verify(bundle, require_clean=True)
    config = json.loads((ROOT / "release/config.json").read_text())
    commit = run(["git", "rev-parse", "HEAD"])
    validate_candidate(manifest, config, commit)
    if re.fullmatch(r"[1-9][0-9]*", run_id) is None:
        raise ValueError("CI run ID must be numeric")
    validate_ci(github(f"repos/{config['repository']}/actions/runs/{run_id}"), config["repository"], commit)
    pending = pending_files(bundle, manifest, "go")
    if pending:
        github(f"repos/{config['repository']}/git/refs", {"ref": "refs/tags/" + pending[0], "sha": commit})
    check_registry(bundle, "go")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("prepare")
    start.add_argument("--run-id", required=True)
    start.add_argument("--registry", choices=["npm", "python", "rust", "go"], required=True)
    start.add_argument("--output", required=True)
    crate = commands.add_parser("check-crate")
    crate.add_argument("--bundle", required=True)
    crate.add_argument("--source", required=True)
    checked = commands.add_parser("verify")
    checked.add_argument("--bundle", required=True)
    checked.add_argument("--registry", choices=["npm", "python", "rust", "go"], required=True)
    go = commands.add_parser("publish-go")
    go.add_argument("--bundle", required=True)
    go.add_argument("--run-id", required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.run_id, args.registry, args.output)
    elif args.command == "check-crate":
        check_crate(args.bundle, args.source)
    elif args.command == "publish-go":
        publish_go(args.bundle, args.run_id)
    else:
        check_registry(args.bundle, args.registry)

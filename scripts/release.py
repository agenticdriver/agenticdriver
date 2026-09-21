"""Build and inspect candidate artifacts. This command never publishes anything.

Release tooling requires Python 3.12+; the Python client still supports 3.10.
Only Git-tracked files enter an isolated build tree. Dirty candidates are clearly
marked and must not be published. Archive verification never extracts files.
"""
import argparse
import datetime
import email.parser
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SEMVER = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z")


def run(args, cwd=ROOT, env=None):
    return subprocess.run(args, cwd=cwd, env=env, check=True, text=True,
                          stdout=subprocess.PIPE, stderr=sys.stderr).stdout.strip()


def safe_path(name):
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name or "\0" in name:
        raise ValueError("Unsafe artifact path")
    if any(part in {".git", "node_modules", "__pycache__", ".env", ".npmrc", ".pypirc"}
           or part.startswith(".env.") or part.endswith((".pem", ".key")) for part in path.parts):
        raise ValueError("Unexpected private/build file in artifact")
    return path


def archive_files(path):
    """Bounded, duplicate-free regular files; reject links and traversal."""
    result = {}
    total = 0
    if path.suffix in {".whl", ".zip"}:
        with zipfile.ZipFile(path) as bundle:
            for entry in bundle.infolist():
                safe_path(entry.filename)
                if entry.is_dir():
                    continue
                mode = entry.external_attr >> 16
                if mode & 0o170000 not in {0, 0o100000} or entry.flag_bits & 1:
                    raise ValueError("Unsupported ZIP member")
                total += entry.file_size
                if total > 64 * 1024 * 1024 or entry.filename in result or len(result) >= 10000:
                    raise ValueError("Oversized or duplicate archive members")
                result[entry.filename] = bundle.read(entry)
    else:
        with tarfile.open(path, "r:gz") as bundle:
            for entry in bundle:
                safe_path(entry.name)
                if entry.isdir():
                    continue
                if not entry.isfile():
                    raise ValueError("Archive links and special files are forbidden")
                total += entry.size
                if total > 64 * 1024 * 1024 or entry.name in result or len(result) >= 10000:
                    raise ValueError("Oversized or duplicate archive members")
                result[entry.name] = bundle.extractfile(entry).read()
    return result


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(directory, require_clean=False):
    directory = Path(directory).resolve()
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest["schemaVersion"] != 1 or not re.fullmatch(r"[0-9a-f]{40}", manifest["commit"]):
        raise ValueError("Unsupported candidate manifest")
    if require_clean and manifest["dirty"]:
        raise ValueError("Dirty development candidates cannot be released")
    listed = set()
    for item in manifest["files"]:
        relative = str(safe_path(item["path"]))
        path = directory / relative
        if relative in listed or not path.resolve().is_relative_to(directory) or path.is_symlink():
            raise ValueError("Duplicate or escaping artifact")
        if path.stat().st_size != item["size"] or sha256(path) != item["sha256"]:
            raise ValueError("Artifact checksum or size mismatch: " + relative)
        listed.add(relative)
    actual = {p.relative_to(directory).as_posix() for p in directory.rglob("*") if p.is_file()}
    if actual != listed | {"manifest.json", "SHA256SUMS"}:
        raise ValueError("Unexpected or missing candidate files")
    checksums = "".join(f'{item["sha256"]}  {item["path"]}\n' for item in manifest["files"])
    if (directory / "SHA256SUMS").read_text() != checksums:
        raise ValueError("Checksum index differs from the manifest")
    packages = manifest["packages"]
    def contents(kind, key):
        file = packages[kind][key]
        if file not in listed:
            raise ValueError("Unlisted package artifact")
        return archive_files(directory / file)
    npm = contents("npm", "archive")
    metadata = json.loads(npm["package/package.json"])
    assert (metadata["name"], metadata["version"]) == (packages["npm"]["name"], packages["npm"]["version"])
    for required in ["LICENSE", "README.md", "dist/cli.js", "dist/client.js", "examples/quickstart/client.mjs"]:
        assert "package/" + required in npm, required
    for entry in metadata["exports"].values():
        for key in ("types", "import"):
            assert "package/" + entry[key].removeprefix("./") in npm
    wheel = contents("python", "wheel")
    sdist = contents("python", "sdist")
    for files, suffix in [(wheel, ".dist-info/METADATA"), (sdist, "/PKG-INFO")]:
        candidates = [body for name, body in files.items() if name.endswith(suffix)]
        assert candidates
        for body in candidates:
            metadata = email.parser.BytesParser().parsebytes(body)
            assert metadata["Name"] == packages["python"]["name"]
            assert metadata["Version"] == packages["python"]["version"]
    assert "agenticdriver/py.typed" in wheel
    assert any(name.endswith("/licenses/LICENSE") for name in wheel)
    crate = contents("rust", "archive")
    prefix = f'{packages["rust"]["name"]}-{packages["rust"]["version"]}/'
    metadata = tomllib.loads(crate[prefix + "Cargo.toml"].decode())["package"]
    assert (metadata["name"], metadata["version"]) == (packages["rust"]["name"], packages["rust"]["version"])
    assert all(prefix + name in crate for name in ["LICENSE", "Cargo.lock", "src/lib.rs"])
    go = contents("go", "archive")
    prefix = packages["go"]["name"] + "@" + packages["go"]["version"] + "/"
    assert all(name.startswith(prefix) for name in go)
    assert go[prefix + "go.mod"].decode().splitlines()[0] == "module " + packages["go"]["name"]
    assert prefix + "LICENSE" in go
    assert (directory / packages["go"]["mod"]).read_bytes() == go[prefix + "go.mod"]
    info = json.loads((directory / packages["go"]["info"]).read_text())
    assert info["Version"] == packages["go"]["version"]
    return manifest


def normalize_tar(path, epoch):
    """Canonical tar metadata/order and gzip header; preserve packaged file bytes."""
    files = archive_files(path)
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=epoch) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as bundle:
            for name, body in sorted(files.items()):
                info = tarfile.TarInfo(name)
                info.size, info.mtime, info.mode = len(body), epoch, 0o644
                bundle.addfile(info, io.BytesIO(body))
    path.write_bytes(output.getvalue())


def build(output, allow_dirty=False):
    dirty = bool(run(["git", "status", "--porcelain", "--untracked-files=all"]))
    if dirty and not allow_dirty:
        raise ValueError("Commit candidate inputs first, or use --allow-dirty for a non-release test bundle")
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    commit = run(["git", "rev-parse", "HEAD"])
    epoch = int(run(["git", "show", "-s", "--format=%ct", "HEAD"]))
    with tempfile.TemporaryDirectory(prefix="agenticdriver-release-") as temporary:
        work = Path(temporary)
        source = work / "source"
        source.mkdir()
        # Untracked files and ignored local runtime/credential directories never enter the build.
        for name in run(["git", "ls-files", "-z"]).split("\0"):
            if not name:
                continue
            safe_path(name)
            origin = ROOT / name
            if not origin.exists():
                continue  # A tracked deletion is explicitly a dirty candidate.
            if origin.is_symlink():
                raise ValueError("Unexpected symlink in release source")
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(origin, target)
        config = json.loads((source / "release/config.json").read_text())
        npm = json.loads((source / "package.json").read_text())
        python = tomllib.loads((source / "clients/python/pyproject.toml").read_text())["project"]
        rust = tomllib.loads((source / "clients/rust/Cargo.toml").read_text())["package"]
        for kind, metadata in [("npm", npm), ("python", python), ("rust", rust)]:
            if metadata["name"] != config["names"][kind] or not SEMVER.fullmatch(metadata["version"]):
                raise ValueError("Review the package identity/version in release/config.json")
        if not SEMVER.fullmatch(config["goVersion"]):
            raise ValueError("An explicit Go module release version is required")
        if json.loads((source / "protocol/openapi.json").read_text())["info"]["version"] != config["protocolVersion"] + ".0":
            raise ValueError("Release protocol does not match the generated contract")
        env = {**os.environ, "SOURCE_DATE_EPOCH": str(epoch)}
        packages = {kind: {"name": metadata["name"], "version": metadata["version"]}
                    for kind, metadata in [("npm", npm), ("python", python), ("rust", rust)]}
        for name in ["npm", "python", "rust", "go"]:
            (output / name).mkdir()
        run(["npm", "ci", "--no-audit", "--no-fund"], source, env)
        run(["npm", "run", "build"], source, env)
        packed = json.loads(run(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", str(output / "npm")], source, env))
        packages["npm"]["archive"] = "npm/" + packed[0]["filename"]
        builder = work / "python-build"
        run([sys.executable, "-m", "venv", str(builder)])
        executable = str(builder / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))
        run([executable, "-m", "pip", "install", "--quiet", "-r", str(source / "release/requirements-build.txt")], source, env)
        run([executable, "-m", "build", "--no-isolation", "--outdir", str(output / "python"), "clients/python"], source, env)
        run([executable, "-m", "twine", "check", *map(str, (output / "python").iterdir())], source, env)
        packages["python"].update(wheel="python/" + next((output / "python").glob("*.whl")).name,
                                  sdist="python/" + next((output / "python").glob("*.tar.gz")).name)
        normalize_tar(output / packages["python"]["sdist"], epoch)
        # Reuse compiler cache only; archives always come from this isolated source.
        target = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "clients/rust/target")).resolve()
        env["CARGO_TARGET_DIR"] = str(target)
        run(["cargo", "+1.89.0", "package", "--locked", "--manifest-path", "clients/rust/Cargo.toml"], source, env)
        crate = f'{rust["name"]}-{rust["version"]}.crate'
        shutil.copyfile(target / "package" / crate, output / "rust" / crate)
        packages["rust"]["archive"] = "rust/" + crate
        version = "v" + config["goVersion"]
        module = config["names"]["go"]
        versions = output / "go" / module / "@v"
        versions.mkdir(parents=True)
        (versions / "list").write_text(version + "\n")
        (versions / (version + ".mod")).write_bytes((source / "clients/go/go.mod").read_bytes())
        date = datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc)
        (versions / (version + ".info")).write_text(json.dumps({"Version": version, "Time": date.isoformat().replace("+00:00", "Z")}))
        with zipfile.ZipFile(versions / (version + ".zip"), "w", zipfile.ZIP_DEFLATED) as bundle:
            for file in sorted((source / "clients/go").rglob("*")):
                if file.is_file():
                    info = zipfile.ZipInfo(module + "@" + version + "/" + file.relative_to(source / "clients/go").as_posix(), date.timetuple()[:6])
                    info.external_attr = 0o100644 << 16
                    bundle.writestr(info, file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
        packages["go"] = {"name": module, "version": version, "tag": "clients/go/" + version,
                          **{key: (versions / (version + suffix)).relative_to(output).as_posix()
                             for key, suffix in [("archive", ".zip"), ("mod", ".mod"), ("info", ".info")]}}
        files = [{"path": path.relative_to(output).as_posix(), "size": path.stat().st_size, "sha256": sha256(path)}
                 for path in sorted(output.rglob("*")) if path.is_file()]
        manifest = {"schemaVersion": 1, "repository": config["repository"], "commit": commit,
                    "dirty": dirty, "sourceDateEpoch": epoch, "protocolVersion": config["protocolVersion"],
                    "packages": packages, "files": files,
                    "tools": {"node": run(["node", "--version"]), "npm": run(["npm", "--version"]),
                              "python": sys.version.split()[0], "cargo": run(["cargo", "+1.89.0", "--version"]),
                              "go": run(["go", "version"])}}
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (output / "SHA256SUMS").write_text("".join(f'{item["sha256"]}  {item["path"]}\n' for item in files))
    verify(output)
    print(json.dumps({"directory": str(output), "commit": commit, "dirty": dirty,
                      "artifacts": len(files), "published": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("build")
    create.add_argument("--output", required=True)
    create.add_argument("--allow-dirty", action="store_true")
    check = commands.add_parser("verify")
    check.add_argument("directory")
    check.add_argument("--require-clean", action="store_true")
    args = parser.parse_args()
    if args.command == "build":
        build(args.output, args.allow_dirty)
    else:
        manifest = verify(args.directory, args.require_clean)
        print(json.dumps({"verified": True, "commit": manifest["commit"], "dirty": manifest["dirty"]}))

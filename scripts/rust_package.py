"""Install the packaged Rust crate in an external application on the declared MSRV."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
MSRV = "1.89.0"
TOOLCHAIN = os.environ.get("AGENTICDRIVER_TEST_RUST_TOOLCHAIN", MSRV)


def prepare_rust(directory: Path) -> tuple[Path, dict[str, str]]:
    target = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "clients/rust/target")).resolve()
    env = {**os.environ, "CARGO_TARGET_DIR": str(target)}
    command = ["cargo", f"+{TOOLCHAIN}"]
    subprocess.run(
        [*command, "package", "--locked", "--allow-dirty"],
        cwd=ROOT / "clients/rust", env=env, check=True, timeout=300,
    )
    archive = target / "package/agenticdriver-0.1.0.crate"
    package_root = directory / "rust-package"
    package_root.mkdir()
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        names = {member.name for member in members}
        for member in members:
            relative = Path(member.name)
            assert not relative.is_absolute() and ".." not in relative.parts
            assert member.isfile() or member.isdir(), member.name
            assert not any(part in {"target", "tests", ".git"} for part in relative.parts)
        assert all(f"agenticdriver-0.1.0/{name}" in names for name in [
            "LICENSE", "README.md", "src/lib.rs", "src/async_client.rs", "src/blocking.rs",
        ])
        bundle.extractall(package_root, filter="data")
    package = package_root / "agenticdriver-0.1.0"
    application = directory / "rust-application"
    (application / "src").mkdir(parents=True)
    (application / "Cargo.toml").write_text(f'''[package]
name = "agenticdriver-installed-app"
version = "0.0.0"
edition = "2021"
rust-version = "1.89"

[features]
default = ["async", "blocking"]
async = ["agenticdriver/async"]
blocking = ["agenticdriver/blocking"]

[dependencies]
agenticdriver = {{ path = {json.dumps(str(package))}, default-features = false }}
tokio = {{ version = "1", features = ["rt", "net", "time"] }}

[[bin]]
name = "agenticdriver-installed-app"
required-features = ["async", "blocking"]
''')
    shutil.copyfile(package / "examples/installed_app.rs", application / "src/main.rs")
    (application / "src/lib.rs").write_text('''use agenticdriver::{Event, EventPayload, RunRequest};
pub fn request() -> RunRequest { RunRequest::new("mock", "demo", "Hello") }
pub fn text(event: &Event) -> agenticdriver::Result<Option<&str>> {
    Ok(match event.payload()? {
        EventPayload::TextDelta { text } => Some(text),
        _ => None,
    })
}
#[cfg(feature = "async")]
pub async fn asynchronous(client: &agenticdriver::AsyncAgenticClient) -> agenticdriver::Result<()> {
    let mut stream = client.stream(&request()).await?;
    while let Some(event) = stream.next().await { text(&event?)?; }
    Ok(())
}
#[cfg(feature = "blocking")]
pub fn blocking(client: &agenticdriver::AgenticClient) -> agenticdriver::Result<()> {
    client.stream(&request(), |event| { text(&event).unwrap(); true })
}
''')
    # Preserve the repository's dependency lock when resolving the packaged crate.
    shutil.copyfile(package / "Cargo.lock", application / "Cargo.lock")
    for features in [[], ["async"], ["blocking"], ["async", "blocking"]]:
        args = [*command, "check", "--lib", "--no-default-features"]
        if features:
            args += ["--features", ",".join(features)]
        subprocess.run(args, cwd=application, env=env, check=True, timeout=300)
    subprocess.run([*command, "build", "--locked"], cwd=application, env=env, check=True, timeout=300)
    result = subprocess.run(
        [*command, "metadata", "--no-deps", "--format-version", "1"],
        cwd=application, env=env, check=True, capture_output=True, text=True, timeout=30,
    )
    metadata = json.loads(result.stdout)
    dependency = next(d for d in metadata["packages"][0]["dependencies"] if d["name"] == "agenticdriver")
    assert Path(dependency["path"]).resolve() == package.resolve()
    print(f"Installed Rust crate: archive contents, independent application and four feature combinations passed on Rust {TOOLCHAIN} (MSRV {MSRV}).", flush=True)
    return application, {"CARGO_TARGET_DIR": str(target)}

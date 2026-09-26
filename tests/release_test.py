"""Reject damaged or unsafe release inputs before any install or upload."""
import io
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import threading
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from release import archive_files, release_channel, safe_path, validate_channels, validate_npm_tag
from publish import pending_files, public_read, validate_candidate, validate_ci


class ReleaseBoundaryTests(unittest.TestCase):
    def test_rejects_traversal_and_private_files(self):
        for name in ["../credential", "/absolute", "package/.env", "package/.npmrc",
                     "package/account.key", "package/../escape", "C:\\secret", "C:/secret", "package/.git/config"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                safe_path(name)

    def test_rejects_tar_link_and_duplicate(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "fixture.tgz"
            with tarfile.open(archive, "w:gz") as bundle:
                item = tarfile.TarInfo("package/link")
                item.type, item.linkname = tarfile.SYMTYPE, "../../secret"
                bundle.addfile(item)
            with self.assertRaises(ValueError):
                archive_files(archive)
            with tarfile.open(archive, "w:gz") as bundle:
                for value in [b"reviewed", b"replaced"]:
                    item = tarfile.TarInfo("package/file")
                    item.size = len(value)
                    bundle.addfile(item, io.BytesIO(value))
            with self.assertRaises(ValueError):
                archive_files(archive)

    def test_rejects_zip_link_and_oversized_expansion(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "fixture.whl"
            with zipfile.ZipFile(archive, "w") as bundle:
                item = zipfile.ZipInfo("link")
                item.external_attr = 0o120777 << 16
                bundle.writestr(item, "../../secret")
            with self.assertRaises(ValueError):
                archive_files(archive)
            # Tar declares the size without allocating a huge decompressed body.
            archive = Path(directory) / "fixture.tgz"
            item = tarfile.TarInfo("package/huge")
            item.size = 65 * 1024 * 1024
            import gzip
            with gzip.open(archive, "wb") as output:
                output.write(item.tobuf())
            with self.assertRaises(ValueError):
                archive_files(archive)


class PublicationBoundaryTests(unittest.TestCase):
    def test_release_channels_accept_canonical_language_versions(self):
        for channel, suffix, python_suffix in [("stable", "", ""), ("alpha", "-alpha.1", "a1"),
                                                ("beta", "-beta.12", "b12"), ("rc", "-rc.2", "rc2")]:
            packages = {"npm": {"version": "0.2.0" + suffix}, "rust": {"version": "0.2.0" + suffix},
                        "python": {"version": "0.2.0" + python_suffix}, "go": {"version": "v0.2.0" + suffix}}
            with self.subTest(channel=channel):
                tag = validate_channels(packages, channel)
                self.assertEqual(tag, "latest" if channel == "stable" else channel)
                validate_npm_tag({"publishConfig": {"tag": tag}}, channel)
                if channel != "stable":
                    with self.assertRaises(ValueError):
                        validate_npm_tag({}, channel)
                    with self.assertRaises(ValueError):
                        validate_npm_tag({"publishConfig": {"tag": "latest"}}, channel)
                    with self.assertRaises(ValueError):
                        validate_channels(packages, "stable")

    def test_noncanonical_prereleases_and_mixed_channels_are_rejected(self):
        for registry, versions in {
            "npm": ["v0.2.0-alpha.1", "0.2.0-alpha.01", "0.2.0-alpha", "0.2.0-alpha.0", "0.2.0a1",
                    "0.2.0-alpha.1+build", "0.2.0-alpha.1/other", "0.2.0-alpha.1\n", "00.2.0"],
            "python": ["0.2.0-alpha.1", "0.2.0a01", "0.2.0A1", "0.2.0a1.dev1", "0.2.0.post1"],
            "go": ["0.2.0-alpha.1", "vv0.2.0-alpha.1", "v0.2.0-alpha.01"],
        }.items():
            for version in versions:
                with self.subTest(registry=registry, version=version), self.assertRaises(ValueError):
                    release_channel(version, registry)
        with self.assertRaises(ValueError):
            validate_channels({"npm": {"version": "0.2.0-alpha.1"}, "python": {"version": "0.2.0"}}, "alpha")
        with self.assertRaises(ValueError):
            validate_channels({"npm": {"version": "0.2.0-alpha.1"}}, "latest")

    def test_alpha_candidate_requires_matching_configuration_and_go_tag(self):
        versions = {"npm": "0.2.0-alpha.1", "python": "0.2.0a1", "rust": "0.2.0-alpha.1", "go": "v0.2.0-alpha.1"}
        config = {"repository": "owner/sdk", "protocolVersion": "1.0", "channel": "alpha",
                  "goVersion": "0.2.0-alpha.1", "names": {registry: "sdk" for registry in versions}}
        manifest = {"repository": "owner/sdk", "commit": "a" * 40, "dirty": False, "protocolVersion": "1.0",
                    "channel": "alpha", "packages": {registry: {"name": "sdk", "version": version}
                                                     for registry, version in versions.items()}}
        validate_candidate(manifest, config, "a" * 40)
        for change in [{"channel": "stable"}, {"goVersion": "0.2.0-alpha.2"}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_candidate(manifest, {**config, **change}, "a" * 40)

    def test_only_successful_same_source_sdk_ci_can_authorize_publication(self):
        record = {"status": "completed", "conclusion": "success", "event": "push",
                  "path": ".github/workflows/ci.yml", "head_sha": "a" * 40,
                  "repository": {"full_name": "owner/sdk"}, "head_repository": {"full_name": "owner/sdk"}}
        validate_ci(record, "owner/sdk", "a" * 40)
        for key, value in [("status", "in_progress"), ("conclusion", "failure"),
                           ("event", "pull_request"), ("path", ".github/workflows/release-candidate.yml"),
                           ("head_sha", "b" * 40), ("repository", {"full_name": "fork/sdk"}),
                           ("head_repository", {"full_name": "fork/sdk"})]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_ci({**record, key: value}, "owner/sdk", "a" * 40)

    def test_wrong_commit_dirty_candidate_and_changed_package_identity_are_rejected(self):
        config = {"repository": "owner/sdk", "protocolVersion": "1.0", "names": {"npm": "sdk"}}
        manifest = {"repository": "owner/sdk", "commit": "a" * 40, "dirty": False,
                    "protocolVersion": "1.0", "packages": {"npm": {"name": "sdk", "version": "0.1.0"}}}
        validate_candidate(manifest, config, "a" * 40)
        for change in [{"commit": "b" * 40}, {"dirty": True}, {"repository": "another/sdk"},
                       {"protocolVersion": "2.0"}, {"packages": {"npm": {"name": "other-package", "version": "0.1.0"}}},
                       {"packages": {"npm": {"name": "sdk", "version": "0.1.0/other"}}}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_candidate({**manifest, **change}, config, "a" * 40)

    def test_pypi_retry_uploads_only_missing_files_and_rejects_any_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory)
            (bundle / "sdk.whl").write_bytes(b"reviewed wheel")
            (bundle / "sdk.tar.gz").write_bytes(b"reviewed sdist")
            manifest = {"packages": {"python": {"name": "sdk", "version": "0.1.0",
                                                "wheel": "sdk.whl", "sdist": "sdk.tar.gz"}}}
            remote = {"info": {"name": "sdk", "version": "0.1.0"}, "urls": [
                {"filename": "sdk.whl", "digests": {"sha256": hashlib.sha256(b"reviewed wheel").hexdigest()}}]}
            with patch("publish.public_json", return_value=remote):
                self.assertEqual(pending_files(bundle, manifest, "python"), ["sdk.tar.gz"])
            altered = copy.deepcopy(remote)
            altered["urls"][0]["digests"]["sha256"] = "0" * 64
            with patch("publish.public_json", return_value=altered), self.assertRaises(ValueError):
                pending_files(bundle, manifest, "python")
            altered = copy.deepcopy(remote)
            altered["urls"].append({"filename": "unexpected.whl"})
            with patch("publish.public_json", return_value=altered), self.assertRaises(ValueError):
                pending_files(bundle, manifest, "python")

    def test_go_tag_retry_never_replaces_an_existing_revision(self):
        manifest = {"repository": "owner/sdk", "commit": "a" * 40,
                    "packages": {"go": {"name": "example.test/sdk", "version": "v0.1.0"}}}
        with patch("publish.github", return_value=None):
            self.assertEqual(pending_files(Path("."), manifest, "go"), ["clients/go/v0.1.0"])
        with patch("publish.github", return_value={"object": {"type": "commit", "sha": "a" * 40}}):
            self.assertEqual(pending_files(Path("."), manifest, "go"), [])
        with patch("publish.github", return_value={"object": {"type": "commit", "sha": "b" * 40}}), self.assertRaises(ValueError):
            pending_files(Path("."), manifest, "go")

    def test_registry_auth_errors_and_redirects_do_not_mean_package_is_absent(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                code = int(self.path[1:])
                self.send_response(code)
                if code == 307:
                    self.send_header("Location", "/404")
                self.end_headers()

            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            origin = f"http://127.0.0.1:{server.server_port}"
            self.assertIsNone(public_read(origin + "/404", missing_ok=True))
            for code in [401, 403, 429, 500, 307]:
                with self.subTest(code=code), self.assertRaises(ValueError):
                    public_read(origin + "/" + str(code), missing_ok=True)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()

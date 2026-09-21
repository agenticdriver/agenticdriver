"""Reject damaged or unsafe release inputs before any install or upload."""
import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from release import archive_files, safe_path


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


if __name__ == "__main__":
    unittest.main()

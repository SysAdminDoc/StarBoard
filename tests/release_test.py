"""Clean-room, reproducibility, and release-metadata checks."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot(dist: Path) -> dict[str, str]:
    return {path.name: sha256(path) for path in sorted(dist.iterdir()) if path.is_file()}


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="starboard-release-") as temporary:
        clean_root = Path(temporary)
        for entry in ("manifest.json", "src", "icons", "LICENSE"):
            source = ROOT / entry
            destination = clean_root / entry
            if source.is_dir():
                shutil.copytree(source, destination)
            else:
                shutil.copy2(source, destination)
        (clean_root / "scripts").mkdir()
        shutil.copy2(ROOT / "scripts" / "build.py", clean_root / "scripts" / "build.py")

        command = [sys.executable, str(clean_root / "scripts" / "build.py")]
        subprocess.run(command, cwd=clean_root, check=True)
        first = snapshot(clean_root / "dist")
        subprocess.run(command, cwd=clean_root, check=True)
        second = snapshot(clean_root / "dist")
        if first != second:
            raise SystemExit("release outputs differ between clean-room builds")

        version = json.loads((clean_root / "manifest.json").read_text(encoding="utf-8"))["version"]
        stem = f"StarBoard-v{version}"
        expected = {
            f"{stem}.zip",
            f"{stem}.zip.sha256",
            f"{stem}.files.sha256",
            f"{stem}.spdx.json",
        }
        if set(second) != expected:
            raise SystemExit(f"unexpected release outputs: {sorted(second)}")
        if list(clean_root.rglob("*.crx")) or list(clean_root.rglob("*.pem")):
            raise SystemExit("clean release generated signing material")

        dist = clean_root / "dist"
        zip_path = dist / f"{stem}.zip"
        expected_hash = (dist / f"{stem}.zip.sha256").read_text(encoding="utf-8").split()[0]
        if expected_hash != sha256(zip_path):
            raise SystemExit("ZIP checksum does not match")

        with zipfile.ZipFile(zip_path) as archive:
            names = archive.namelist()
            if "manifest.json" not in names or "LICENSE" not in names:
                raise SystemExit("ZIP omits required release files")
            if any(name.startswith(("tests/", "scripts/")) for name in names):
                raise SystemExit("ZIP includes development-only files")
            if any(name.endswith((".crx", ".pem")) for name in names):
                raise SystemExit("ZIP includes signing material")
            # Building twice on one machine cannot see a field that varies by
            # operating system, so assert the pinned values directly. The
            # shipped v1.2.0 archive carried create_system=0 on all 26 entries
            # purely because it was built on Windows.
            if names != sorted(names):
                raise SystemExit("ZIP entries are not in sorted order")
            for info in archive.infolist():
                if info.date_time != (1980, 1, 1, 0, 0, 0):
                    raise SystemExit(f"{info.filename} carries a build timestamp")
                if info.create_system != 3:
                    raise SystemExit(
                        f"{info.filename} records create_system={info.create_system},"
                        " which varies by build host"
                    )
                if info.compress_type != zipfile.ZIP_STORED:
                    raise SystemExit(f"{info.filename} carries host-dependent compression")
                if info.external_attr >> 16 != 0o644:
                    raise SystemExit(f"{info.filename} carries host file permissions")
            members = {info.filename: archive.read(info.filename) for info in archive.infolist()}

        sbom = json.loads((dist / f"{stem}.spdx.json").read_text(encoding="utf-8"))
        if sbom.get("spdxVersion") != "SPDX-2.3":
            raise SystemExit("SBOM is not SPDX 2.3")
        sbom_files = {
            entry["fileName"].removeprefix("./"): {
                item["algorithm"]: item["checksumValue"] for item in entry["checksums"]
            }
            for entry in sbom.get("files", [])
        }
        if set(sbom_files) != set(members):
            raise SystemExit("SBOM inventory does not name the same files as the ZIP")

        # Counting lines proved only that the sidecars were the right length.
        # Check that every recorded hash is the hash of the shipped bytes.
        manifest_lines = (
            dist / f"{stem}.files.sha256"
        ).read_text(encoding="utf-8").splitlines()
        recorded = {}
        for line in manifest_lines:
            value, _, name = line.partition("  ")
            recorded[name] = value
        if set(recorded) != set(members):
            raise SystemExit("per-file hash manifest does not name the same files as the ZIP")
        for name, payload in members.items():
            actual = hashlib.sha256(payload).hexdigest()
            if recorded[name] != actual:
                raise SystemExit(f"{name}: recorded hash does not match the shipped bytes")
            if sbom_files[name]["SHA256"] != actual:
                raise SystemExit(f"{name}: SBOM hash does not match the shipped bytes")
            if sbom_files[name]["SHA1"] != hashlib.sha1(payload).hexdigest():
                raise SystemExit(f"{name}: SBOM SHA1 does not match the shipped bytes")

    print("PASS  clean release is unsigned, complete, and byte-reproducible")


if __name__ == "__main__":
    main()

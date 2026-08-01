"""Build StarBoard's unsigned, reproducible release bundle.

    py -3.12 scripts/build.py

Outputs to dist/:
    StarBoard-vX.Y.Z.zip
    StarBoard-vX.Y.Z.zip.sha256
    StarBoard-vX.Y.Z.files.sha256
    StarBoard-vX.Y.Z.spdx.json

The ZIP is suitable for Chrome Web Store upload or Load unpacked after
extraction. StarBoard does not generate a packing key or CRX.
"""

from __future__ import annotations

import hashlib
import json
import posixpath
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
INCLUDE = ("manifest.json", "src", "icons", "LICENSE")
EXCLUDE_SUFFIXES = {".map", ".pem"}
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
# 3 = Unix. Pinned so a Windows build and a Linux build agree byte for byte.
ZIP_CREATE_SYSTEM = 3
ZIP_COMPRESS_LEVEL = 9


def version() -> str:
    return json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]


def collect() -> list[tuple[Path, str]]:
    """Return (absolute path, archive name) for every shipping file."""
    files: list[tuple[Path, str]] = []
    for entry in INCLUDE:
        path = ROOT / entry
        if path.is_file():
            files.append((path, entry))
        elif path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file() and child.suffix.lower() not in EXCLUDE_SUFFIXES:
                    files.append((child, child.relative_to(ROOT).as_posix()))
        else:
            raise SystemExit(f"missing required path: {entry}")
    return sorted(files, key=lambda item: item[1])


def digest(path: Path, algorithm: str = "sha256") -> str:
    hasher = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def build_zip(dest: Path, files: list[tuple[Path, str]] | None = None) -> Path:
    """Write an archive whose bytes depend only on the files that went into it.

    Every field that would otherwise carry the build host has to be pinned.
    `create_system` is the one that bites: zipfile defaults it to 0 on Windows
    and 3 everywhere else, so the same sources produced two different published
    checksums depending on who ran the build. The compression level matters for
    the same reason, and supplying an explicit ZipInfo makes the ZipFile-level
    `compresslevel` inert -- it has to be passed per entry.
    """
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=ZIP_COMPRESS_LEVEL) as archive:
        for path, name in files or collect():
            info = zipfile.ZipInfo(name, date_time=ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = ZIP_CREATE_SYSTEM
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes(), compresslevel=ZIP_COMPRESS_LEVEL)
    return dest


def build_file_manifest(
    dest: Path,
    files: list[tuple[Path, str]],
) -> Path:
    lines = [f"{digest(path)}  {name}" for path, name in files]
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return dest


def _spdx_file(path: Path, name: str) -> dict[str, Any]:
    identifier = hashlib.sha256(name.encode("utf-8")).hexdigest()[:16]
    return {
        "SPDXID": f"SPDXRef-File-{identifier}",
        "fileName": f"./{name}",
        "checksums": [
            {"algorithm": "SHA1", "checksumValue": digest(path, "sha1")},
            {"algorithm": "SHA256", "checksumValue": digest(path)},
        ],
        "licenseConcluded": "MIT",
        "licenseInfoInFiles": ["MIT"],
        "copyrightText": "Copyright (c) SysAdminDoc",
    }


def build_spdx(
    dest: Path,
    files: list[tuple[Path, str]],
    release_version: str,
) -> Path:
    spdx_files = [_spdx_file(path, name) for path, name in files]
    content_identity = hashlib.sha256(
        "".join(
            item["checksums"][1]["checksumValue"]
            for item in spdx_files
        ).encode("ascii")
    ).hexdigest()
    verification_code = hashlib.sha1(
        "".join(
            sorted(item["checksums"][0]["checksumValue"] for item in spdx_files)
        ).encode("ascii")
    ).hexdigest()
    package_id = "SPDXRef-Package-StarBoard"
    document_id = "SPDXRef-DOCUMENT"
    document = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": document_id,
        "name": f"StarBoard-{release_version}",
        "documentNamespace": (
            "https://github.com/SysAdminDoc/StarBoard/spdx/"
            f"{release_version}-{content_identity[:20]}"
        ),
        "creationInfo": {
            "created": "1980-01-01T00:00:00Z",
            "creators": ["Tool: StarBoard scripts/build.py"],
        },
        "documentDescribes": [package_id],
        "packages": [
            {
                "SPDXID": package_id,
                "name": "StarBoard",
                "versionInfo": release_version,
                "downloadLocation": "NOASSERTION",
                "filesAnalyzed": True,
                "packageVerificationCode": {
                    "packageVerificationCodeValue": verification_code,
                },
                "licenseConcluded": "MIT",
                "licenseDeclared": "MIT",
                "copyrightText": "Copyright (c) SysAdminDoc",
                "supplier": "Person: SysAdminDoc",
            }
        ],
        "files": spdx_files,
        "relationships": [
            {
                "spdxElementId": document_id,
                "relationshipType": "DESCRIBES",
                "relatedSpdxElement": package_id,
            },
            *[
                {
                    "spdxElementId": package_id,
                    "relationshipType": "CONTAINS",
                    "relatedSpdxElement": item["SPDXID"],
                }
                for item in spdx_files
            ],
        ],
    }
    dest.write_text(
        json.dumps(document, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return dest


def manifest_references(manifest: dict) -> set[str]:
    """Every packaged path the manifest points at.

    Comparing the archive against the list that produced it is a tautology, so
    it cannot catch a renamed popup or a missing icon. Chrome refuses to load
    such a package while the build, the checks and the release test all pass.
    """
    referenced: set[str] = set()

    def add(value) -> None:
        if isinstance(value, str) and value and not value.startswith(("http://", "https://")):
            referenced.add(value.lstrip("/"))

    add(manifest.get("action", {}).get("default_popup"))
    add(manifest.get("options_ui", {}).get("page"))
    add(manifest.get("options_page"))
    add(manifest.get("background", {}).get("service_worker"))
    for script in manifest.get("background", {}).get("scripts", []) or []:
        add(script)
    for icons in (manifest.get("icons", {}), manifest.get("action", {}).get("default_icon", {})):
        if isinstance(icons, dict):
            for path in icons.values():
                add(path)
        else:
            add(icons)
    for entry in manifest.get("web_accessible_resources", []) or []:
        for path in entry.get("resources", []) or []:
            if "*" not in path:
                add(path)
    for entry in manifest.get("content_scripts", []) or []:
        for path in (entry.get("js", []) or []) + (entry.get("css", []) or []):
            add(path)
    return referenced


def verify_zip(zip_path: Path, files: list[tuple[Path, str]]) -> None:
    expected = [name for _, name in files]
    with zipfile.ZipFile(zip_path) as archive:
        actual = archive.namelist()
        if actual != expected:
            raise SystemExit(f"ZIP contents differ: expected {expected}, got {actual}")
        if any(name.endswith((".pem", ".crx")) or name.startswith(("tests/", "scripts/")) for name in actual):
            raise SystemExit("ZIP contains a prohibited development or signing file")
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("version") != version():
            raise SystemExit("ZIP manifest version does not match the source manifest")
        packaged = set(actual)
        missing = sorted(manifest_references(manifest) - packaged)
        if missing:
            raise SystemExit(
                "manifest references files the ZIP does not contain: " + ", ".join(missing)
            )

        broken: list[str] = []

        def line_number(text: str, index: int) -> int:
            return text.count("\n", 0, index) + 1

        def check_reference(
            referrer: str,
            text: str,
            index: int,
            specifier: str,
            kind: str,
            *,
            root_relative: bool = False,
        ) -> None:
            if re.match(r"^(?:[a-z][a-z\d+.-]*:|//|#)", specifier, re.IGNORECASE):
                return
            path = re.split(r"[?#]", specifier, maxsplit=1)[0]
            if not path:
                return
            if root_relative or path.startswith("/"):
                target = posixpath.normpath(path.lstrip("/"))
            else:
                target = posixpath.normpath(posixpath.join(posixpath.dirname(referrer), path))
            if target in packaged:
                return
            broken.append(
                f'{referrer}:{line_number(text, index)}: {kind} references missing file "{specifier}"'
            )

        html_reference = {
            "script": "src",
            "link": "href",
            "img": "src",
        }
        for name in sorted(path for path in packaged if path.startswith("src/") and path.endswith(".html")):
            text = archive.read(name).decode("utf-8")
            for tag, attribute in html_reference.items():
                pattern = re.compile(
                    rf"<{tag}\b[^>]*\b{attribute}\s*=\s*(?:[\"']([^\"']+)[\"']|([^\s>]+))",
                    re.IGNORECASE,
                )
                for match in pattern.finditer(text):
                    check_reference(
                        name,
                        text,
                        match.start(),
                        match.group(1) or match.group(2),
                        f"<{tag}> {attribute}",
                    )

        import_patterns = (
            re.compile(r"\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?[\"'](\.[^\"']+)[\"']"),
            re.compile(r"\bimport\s*\(\s*[\"'](\.[^\"']+)[\"']\s*\)"),
        )
        for name in sorted(path for path in packaged if path.startswith("src/") and path.endswith(".js")):
            text = archive.read(name).decode("utf-8")
            for pattern in import_patterns:
                for match in pattern.finditer(text):
                    check_reference(
                        name,
                        text,
                        match.start(),
                        match.group(1),
                        "ES module import",
                    )

        background_name = "src/background.js"
        background_text = archive.read(background_name).decode("utf-8")
        offscreen_path = re.search(
            r"\bconst\s+OFFSCREEN_PATH\s*=\s*[\"']([^\"']+)[\"']",
            background_text,
        )
        if offscreen_path is None:
            broken.append(f"{background_name}:1: OFFSCREEN_PATH declaration not found")
        else:
            check_reference(
                background_name,
                background_text,
                offscreen_path.start(),
                offscreen_path.group(1),
                "OFFSCREEN_PATH",
                root_relative=True,
            )

        if broken:
            raise SystemExit("ZIP contains broken source references:\n" + "\n".join(broken))


def clean_dist() -> None:
    resolved_dist = DIST.resolve()
    if resolved_dist.parent != ROOT.resolve() or resolved_dist.name != "dist":
        raise SystemExit(f"refusing to clean unexpected output path: {resolved_dist}")
    if resolved_dist.exists():
        shutil.rmtree(resolved_dist)
    resolved_dist.mkdir(parents=True)


def main() -> None:
    release_version = version()
    clean_dist()
    files = collect()
    stem = f"StarBoard-v{release_version}"
    zip_path = build_zip(DIST / f"{stem}.zip", files)
    verify_zip(zip_path, files)

    zip_hash = digest(zip_path)
    hash_path = DIST / f"{stem}.zip.sha256"
    hash_path.write_text(
        f"{zip_hash}  {zip_path.name}\n",
        encoding="utf-8",
        newline="\n",
    )
    files_path = build_file_manifest(DIST / f"{stem}.files.sha256", files)
    spdx_path = build_spdx(DIST / f"{stem}.spdx.json", files, release_version)

    print(f"StarBoard v{release_version} - {len(files)} files")
    for artifact in (zip_path, hash_path, files_path, spdx_path):
        print(f"  {artifact.relative_to(ROOT)}  ({artifact.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

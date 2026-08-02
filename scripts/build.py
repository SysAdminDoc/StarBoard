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
import os
import posixpath
import re
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
ALLOWED_FILES = (
    "LICENSE",
    "icons/icon128.png",
    "icons/icon16.png",
    "icons/icon32.png",
    "icons/icon48.png",
    "manifest.json",
    "_locales/en/messages.json",
    "_locales/en_XA/messages.json",
    "src/background.js",
    "src/lib/diagnostics.js",
    "src/lib/github.js",
    "src/lib/history.js",
    "src/lib/i18n.js",
    "src/lib/install.js",
    "src/lib/lifecycle.js",
    "src/lib/notifications.js",
    "src/lib/portfolio-views.js",
    "src/lib/refresh-coordinator.js",
    "src/lib/request.js",
    "src/lib/scrape.js",
    "src/lib/storage.js",
    "src/lib/transfer.js",
    "src/offscreen.html",
    "src/offscreen.js",
    "src/options.css",
    "src/options.html",
    "src/options.js",
    "src/popup.css",
    "src/popup.html",
    "src/popup.js",
)
SHIPPING_ROOTS = ("src", "icons", "_locales")
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
# 3 = Unix. Pinned so a Windows build and a Linux build agree byte for byte.
ZIP_CREATE_SYSTEM = 3
ZIP_COMPRESSION = zipfile.ZIP_STORED
TEXT_SUFFIXES = {".css", ".html", ".js", ".json", ".txt"}


def version() -> str:
    return json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]


def collect() -> list[tuple[Path, str]]:
    """Return (absolute path, archive name) for every shipping file."""
    allowed = set(ALLOWED_FILES)
    missing = sorted(name for name in allowed if not (ROOT / name).is_file())
    actual = {
        child.relative_to(ROOT).as_posix()
        for entry in SHIPPING_ROOTS
        for child in (ROOT / entry).rglob("*")
        if child.is_file()
    }
    unexpected = sorted(actual - allowed)
    if missing:
        raise SystemExit("release allow-list paths are missing: " + ", ".join(missing))
    if unexpected:
        raise SystemExit("unexpected files under shipping roots: " + ", ".join(unexpected))
    return [(ROOT / name, name) for name in sorted(allowed)]


def git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def source_commit() -> str:
    supplied = os.environ.get("STARBOARD_SOURCE_COMMIT", "").strip().lower()
    if re.fullmatch(r"[a-f0-9]{40}", supplied):
        return supplied
    result = git("rev-parse", "HEAD")
    commit = result.stdout.strip().lower()
    return commit if result.returncode == 0 and re.fullmatch(r"[a-f0-9]{40}", commit) else "NOASSERTION"


def require_clean_tree() -> None:
    if os.environ.get("STARBOARD_ALLOW_DIRTY_BUILD") == "1":
        return
    inside = git("rev-parse", "--is-inside-work-tree")
    if inside.returncode != 0:
        return
    status = git(
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ".",
        ":(exclude)dist",
        ":(exclude)dist/**",
    )
    if status.returncode != 0:
        raise SystemExit(status.stderr.strip() or "could not inspect the source tree")
    if status.stdout.strip():
        raise SystemExit(
            "refusing to build from a dirty tree; commit the release source or set "
            "STARBOARD_ALLOW_DIRTY_BUILD=1 for an intentional development build"
        )


def shipping_bytes(path: Path, name: str) -> bytes:
    """Return the canonical bytes placed in the release archive.

    Git checkouts can materialize the same text blob with LF or CRLF depending
    on host configuration. Normalize shipping text here so third-party builds
    do not need a particular global Git setting. LICENSE is the only extension-
    less text file in the package.
    """
    payload = path.read_bytes()
    if path.suffix.lower() in TEXT_SUFFIXES or name == "LICENSE":
        return payload.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return payload


def digest_bytes(payload: bytes, algorithm: str = "sha256") -> str:
    hasher = hashlib.new(algorithm)
    hasher.update(payload)
    return hasher.hexdigest()


def digest(path: Path, algorithm: str = "sha256") -> str:
    return digest_bytes(path.read_bytes(), algorithm)


def build_zip(dest: Path, files: list[tuple[Path, str]] | None = None) -> Path:
    """Write an archive whose bytes depend only on the files that went into it.

    Every field that would otherwise carry the build host has to be pinned.
    `create_system` is the first host-dependent field: zipfile defaults it to 0
    on Windows and 3 elsewhere. DEFLATE is another: the same Python version can
    link different zlib implementations whose level-9 output is valid but not
    byte-identical. Stored entries avoid that hidden dependency while keeping
    the release standard-library-only and small enough for extension delivery.
    """
    with zipfile.ZipFile(dest, "w", compression=ZIP_COMPRESSION) as archive:
        for path, name in files or collect():
            info = zipfile.ZipInfo(name, date_time=ZIP_TIMESTAMP)
            info.compress_type = ZIP_COMPRESSION
            info.create_system = ZIP_CREATE_SYSTEM
            info.external_attr = 0o644 << 16
            archive.writestr(info, shipping_bytes(path, name))
    return dest


def build_file_manifest(
    dest: Path,
    files: list[tuple[Path, str]],
) -> Path:
    lines = [f"{digest_bytes(shipping_bytes(path, name))}  {name}" for path, name in files]
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return dest


def _spdx_file(path: Path, name: str) -> dict[str, Any]:
    identifier = hashlib.sha256(name.encode("utf-8")).hexdigest()[:16]
    payload = shipping_bytes(path, name)
    return {
        "SPDXID": f"SPDXRef-File-{identifier}",
        "fileName": f"./{name}",
        "checksums": [
            {"algorithm": "SHA1", "checksumValue": digest_bytes(payload, "sha1")},
            {"algorithm": "SHA256", "checksumValue": digest_bytes(payload)},
        ],
        "licenseConcluded": "MIT",
        "licenseInfoInFiles": ["MIT"],
        "copyrightText": "Copyright (c) SysAdminDoc",
    }


DEV_TOOL_RELATIONSHIP = {
    "playwright": "TEST_TOOL_OF",
    "typescript": "DEV_TOOL_OF",
    "@types/chrome": "DEV_DEPENDENCY_OF",
    "@types/node": "DEV_DEPENDENCY_OF",
    "Pillow": "BUILD_TOOL_OF",
}


def _dev_components() -> list[tuple[str, str, str]]:
    """Build-time components as (name, version, relationship).

    None of these are inside the ZIP. Listing them anyway, explicitly labelled,
    is what stops a scanner reading the SBOM from attributing their advisories
    to the shipped extension — the same advisories were otherwise re-raised
    every quarter against a package that does not contain them.
    """
    components: list[tuple[str, str, str]] = []
    manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    for name, spec in sorted((manifest.get("devDependencies") or {}).items()):
        version = str(spec).lstrip("^~>=< ")
        components.append((name, version, DEV_TOOL_RELATIONSHIP.get(name, "DEV_DEPENDENCY_OF")))
    for line in (ROOT / "requirements-icons.txt").read_text(encoding="utf-8").splitlines():
        entry = line.split("#", 1)[0].strip()
        if not entry or "==" not in entry:
            continue
        name, _, version = entry.partition("==")
        components.append(
            (name.strip(), version.strip(), DEV_TOOL_RELATIONSHIP.get(name.strip(), "BUILD_TOOL_OF"))
        )
    return components


def build_spdx(
    dest: Path,
    files: list[tuple[Path, str]],
    release_version: str,
    commit: str,
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
    dev_components = _dev_components()
    dev_packages = []
    dev_relationships = []
    for name, version, relationship in dev_components:
        identifier = hashlib.sha256(name.encode("utf-8")).hexdigest()[:16]
        component_id = f"SPDXRef-Package-Dev-{identifier}"
        dev_packages.append(
            {
                "SPDXID": component_id,
                "name": name,
                "versionInfo": version,
                "downloadLocation": "NOASSERTION",
                # Nothing here is in the artifact, so there are no files to
                # analyze and no verification code to compute.
                "filesAnalyzed": False,
                "licenseConcluded": "NOASSERTION",
                "licenseDeclared": "NOASSERTION",
                "copyrightText": "NOASSERTION",
                "supplier": "NOASSERTION",
                "comment": "Build-time only. Not present in the released extension package.",
            }
        )
        dev_relationships.append(
            {
                "spdxElementId": component_id,
                "relationshipType": relationship,
                "relatedSpdxElement": package_id,
            }
        )
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
            *dev_packages,
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
                "sourceInfo": f"git commit {commit}",
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
            *dev_relationships,
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
    require_clean_tree()
    release_version = version()
    commit = source_commit()
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
    spdx_path = build_spdx(DIST / f"{stem}.spdx.json", files, release_version, commit)

    print(f"StarBoard v{release_version} - {len(files)} files")
    for artifact in (zip_path, hash_path, files_path, spdx_path):
        print(f"  {artifact.relative_to(ROOT)}  ({artifact.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

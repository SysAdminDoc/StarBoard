"""Build StarBoard's distributables: an unpacked-loadable ZIP and a CRX3.

    py -3.12 scripts/build.py

Outputs to dist/:
    StarBoard-vX.Y.Z.zip   <- primary install asset (Load unpacked / CWS upload)
    StarBoard-vX.Y.Z.crx   <- CRX3, self-host key, stable extension ID

The .pem is a self-host packing key, not a code-signing certificate. Chromium
rejects self-signed CRX files installed by drag-and-drop
(CRX_REQUIRED_PROOF_MISSING), so the ZIP is the asset users actually install.
The CRX exists so the extension ID stays stable across builds.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import struct
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
KEY = ROOT / ".keys" / "starboard.pem"

INCLUDE = ("manifest.json", "src", "icons", "LICENSE")
EXCLUDE_SUFFIXES = {".map", ".pem"}


def version() -> str:
    return json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]


def collect() -> list[tuple[Path, str]]:
    """(absolute path, archive name) for every file that ships."""
    files: list[tuple[Path, str]] = []
    for entry in INCLUDE:
        path = ROOT / entry
        if path.is_file():
            files.append((path, entry))
        elif path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file() and child.suffix not in EXCLUDE_SUFFIXES:
                    files.append((child, child.relative_to(ROOT).as_posix()))
        else:
            raise SystemExit(f"missing required path: {entry}")
    return files


def build_zip(dest: Path) -> Path:
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path, name in collect():
            # Fixed timestamp keeps the archive byte-identical between builds.
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())
    return dest


def load_key() -> rsa.RSAPrivateKey:
    if KEY.exists():
        return serialization.load_pem_private_key(KEY.read_bytes(), password=None)
    KEY.parent.mkdir(parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    KEY.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    print(f"generated new self-host key at {KEY.relative_to(ROOT)} (gitignored — back it up)")
    return key


def _tag(field: int, wire: int) -> bytes:
    """Protobuf tag byte(s) — varint of (field << 3 | wire_type)."""
    value = field << 3 | wire
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def _field(number: int, payload: bytes) -> bytes:
    """A length-delimited (wire type 2) protobuf field."""
    return _tag(number, 2) + _varint(len(payload)) + payload


def build_crx(zip_path: Path, dest: Path) -> tuple[Path, str]:
    key = load_key()
    pubkey_der = key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    crx_id = hashlib.sha256(pubkey_der).digest()[:16]

    # CrxFileHeader.signed_header_data = SignedData{ crx_id = field 1 }
    signed_header_data = _field(1, crx_id)

    payload = zip_path.read_bytes()
    to_sign = (
        b"CRX3 SignedData\x00"
        + struct.pack("<I", len(signed_header_data))
        + signed_header_data
        + payload
    )
    signature = key.sign(to_sign, padding.PKCS1v15(), hashes.SHA256())

    # AsymmetricKeyProof{ public_key = 1, signature = 2 }
    proof = _field(1, pubkey_der) + _field(2, signature)
    header = (
        _field(2, proof)  # sha256_with_rsa
        + _field(10000, signed_header_data)
    )

    dest.write_bytes(
        b"Cr24" + struct.pack("<II", 3, len(header)) + header + payload
    )

    # Extension ID: crx_id hex mapped from 0-9a-f onto a-p.
    ext_id = "".join(chr(ord("a") + int(c, 16)) for c in crx_id.hex())
    return dest, ext_id


def main() -> None:
    ver = version()
    if DIST.exists():
        shutil.rmtree(DIST)  # never leave stale artifacts beside current ones
    DIST.mkdir(parents=True)

    files = collect()
    zip_path = build_zip(DIST / f"StarBoard-v{ver}.zip")
    crx_path, ext_id = build_crx(zip_path, DIST / f"StarBoard-v{ver}.crx")

    print(f"StarBoard v{ver} — {len(files)} files")
    print(f"  {zip_path.relative_to(ROOT)}  ({zip_path.stat().st_size / 1024:.1f} KB)")
    print(f"  {crx_path.relative_to(ROOT)}  ({crx_path.stat().st_size / 1024:.1f} KB)")
    print(f"  extension id: {ext_id}")


if __name__ == "__main__":
    main()

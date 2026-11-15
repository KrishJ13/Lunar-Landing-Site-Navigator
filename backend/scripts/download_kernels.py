"""Download NAIF kernels listed in kernels_manifest.json and verify SHA-256.

Usage: python scripts/download_kernels.py [--update-hashes]
Without --update-hashes, a checksum mismatch is an error (reproducible setup).
"""
import hashlib
import json
import shutil
import ssl
import sys
from urllib.request import urlopen
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "kernels_manifest.json"
KDIR = ROOT / "kernels"

def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()

def main():
    update = "--update-hashes" in sys.argv
    m = json.loads(MANIFEST.read_text())
    KDIR.mkdir(exist_ok=True)
    context = ssl.create_default_context()
    try:
        import certifi
    except ImportError:
        pass
    else:
        context.load_verify_locations(cafile=certifi.where())
    for k in m["kernels"]:
        dest = KDIR / k["filename"]
        if not dest.exists():
            print(f"downloading {k['url']}")
            tmp = dest.with_suffix(dest.suffix + ".part")
            with urlopen(k["url"], context=context, timeout=60) as response, tmp.open("wb") as out:
                shutil.copyfileobj(response, out)
            tmp.replace(dest)
        digest = sha256(dest)
        if update and not k.get("sha256"):
            k["sha256"] = digest
        elif digest != k.get("sha256"):
            sys.exit(f"CHECKSUM MISMATCH {k['filename']}: {digest} != {k.get('sha256')}")
        print(f"ok {k['filename']} {digest[:12]}")
    if update:
        MANIFEST.write_text(json.dumps(m, indent=2) + "\n")

if __name__ == "__main__":
    main()

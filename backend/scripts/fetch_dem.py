"""Download LOLA elevation maps from NASA PDS into backend/data/dem/.

Usage (from backend/):
    python scripts/fetch_dem.py --list              # show what is available
    python scripts/fetch_dem.py --tier starter      # ~128 MB, recommended first
    python scripts/fetch_dem.py ldem_80s_80m        # one product by name

Already-complete files are skipped, and each download is checked against the
size the server reports, so re-running after an interruption is safe.
"""

import argparse
import shutil
import ssl
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lunar.config import DEM_DIR  # noqa: E402
from lunar.dem.catalog import CATALOG, ProductInfo, catalog_entry  # noqa: E402


def _ssl_context() -> ssl.SSLContext:
    # python.org builds on macOS often lack a CA bundle; certifi provides one.
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def download(url: str, dest: Path, context: ssl.SSLContext) -> None:
    with urllib.request.urlopen(url, context=context) as response:
        total = int(response.headers.get("Content-Length", 0))
        if dest.exists() and total and dest.stat().st_size == total:
            print(f"  skip {dest.name} (already complete)")
            return
        tmp = dest.with_suffix(dest.suffix + ".part")
        done = 0
        with open(tmp, "wb") as out:
            while chunk := response.read(1 << 20):
                out.write(chunk)
                done += len(chunk)
                if total:
                    print(f"\r  {dest.name}: {done / total:6.1%} of {total / 1e6:,.0f} MB", end="")
        print()
        if total and done != total:
            raise IOError(f"{dest.name}: got {done} bytes, expected {total}")
        shutil.move(tmp, dest)


def fetch(info: ProductInfo, dem_dir: Path, context: ssl.SSLContext) -> None:
    print(f"{info.name}  ({info.coverage}, {info.pixel_size_m:g} m/pixel, ~{info.approx_bytes / 1e6:,.0f} MB)")
    for suffix in ("lbl", "img"):
        download(info.url(suffix), dem_dir / f"{info.stem}.{suffix}", context)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("names", nargs="*", help="product names, e.g. ldem_16")
    parser.add_argument("--tier", choices=sorted({p.tier for p in CATALOG}))
    parser.add_argument("--list", action="store_true", help="list known products")
    parser.add_argument("--dir", type=Path, default=DEM_DIR, help=f"destination (default {DEM_DIR})")
    args = parser.parse_args()

    if args.list or not (args.names or args.tier):
        for p in CATALOG:
            print(f"{p.name:16} {p.tier:8} {p.coverage:10} {p.pixel_size_m:>6g} m/px  ~{p.approx_bytes / 1e6:>7,.0f} MB")
        return

    selected = [catalog_entry(n) for n in args.names]
    if args.tier:
        selected += [p for p in CATALOG if p.tier == args.tier and p not in selected]

    args.dir.mkdir(parents=True, exist_ok=True)
    context = _ssl_context()
    for info in selected:
        fetch(info, args.dir, context)


if __name__ == "__main__":
    main()

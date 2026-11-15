"""Load the NAIF kernel set from kernels_manifest.json."""
import json
from pathlib import Path
import spiceypy as sp

ROOT = Path(__file__).resolve().parents[1]
KDIR = ROOT / "kernels"
# Load order: LSK, FK, SPK, PCK (order is irrelevant to SPICE but kept explicit).
LOAD_ORDER = ["naif0012.tls", "moon_de440_250416.tf", "de440s.bsp", "moon_pa_de440_200625.bpc"]
MOON_FRAME = "MOON_ME_DE440_ME421"  # Mean Earth / polar axis (see project plan)

def load_kernels():
    sp.kclear()
    for name in LOAD_ORDER:
        sp.furnsh(str(KDIR / name))

def spk_coverage_et(body):
    cell = sp.stypes.SPICEDOUBLE_CELL(2000)
    sp.spkcov(str(KDIR / "de440s.bsp"), body, cell)
    return [(cell[i], cell[i + 1]) for i in range(0, len(cell), 2)]

def pck_coverage_et(frame_class_id):
    cell = sp.stypes.SPICEDOUBLE_CELL(2000)
    sp.pckcov(str(KDIR / "moon_pa_de440_200625.bpc"), frame_class_id, cell)
    return [(cell[i], cell[i + 1]) for i in range(0, len(cell), 2)]

def et_to_utc(et):
    return sp.et2utc(et, "ISOC", 0)

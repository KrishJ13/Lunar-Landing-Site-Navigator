import hashlib, json, sys
from pathlib import Path
import pytest, spiceypy as sp
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lunar_sky.kernels import *

@pytest.fixture(scope="module", autouse=True)
def loaded():
    load_kernels()
    yield
    sp.kclear()

def test_checksums_match_manifest():
    for k in json.loads((ROOT / "kernels_manifest.json").read_text())["kernels"]:
        assert hashlib.sha256((KDIR / k["filename"]).read_bytes()).hexdigest() == k["sha256"]

def test_lunar_frames_resolve():
    assert sp.namfrm(MOON_FRAME) != 0
    assert sp.namfrm("MOON_PA_DE440") != 0

def test_coverage_includes_2026_to_2030():
    a, b = sp.str2et("2026-01-01"), sp.str2et("2030-01-01")
    for body in (10, 399):
        assert any(s <= a and b <= e for s, e in spk_coverage_et(body))
    pa = sp.namfrm("MOON_PA_DE440")
    assert any(s <= a and b <= e for s, e in pck_coverage_et(pa))

def test_real_sun_and_earth_positions():
    et = sp.str2et("2026-11-14T12:00:00")
    sun, _ = sp.spkpos("SUN", et, MOON_FRAME, "LT+S", "MOON")
    earth, _ = sp.spkpos("EARTH", et, MOON_FRAME, "LT+S", "MOON")
    assert 1.47e8 < sp.vnorm(sun) < 1.53e8      # km, ~1 AU
    assert 356_000 < sp.vnorm(earth) < 407_000  # km, lunar distance range

def test_frame_rotation_is_orthonormal():
    r = sp.pxform("J2000", MOON_FRAME, sp.str2et("2026-11-14T12:00:00"))
    assert abs(abs(sp.det(r)) - 1) < 1e-12

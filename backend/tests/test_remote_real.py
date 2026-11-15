"""Remote LOLA reads checked against real data. Network access needed, so opt in:

    LUNAR_NETWORK_TESTS=1 python -m pytest -s tests/test_remote_real.py

Blocks are cached under a pytest temp folder, so every run really hits the server.
"""

import os

import numpy as np
import pytest

from lunar.config import DEM_DIR
from lunar.dem import DemProduct
from lunar.dem.remote import open_remote, remote_specs

pytestmark = [
    pytest.mark.network,
    pytest.mark.skipif(os.environ.get("LUNAR_NETWORK_TESTS") != "1", reason="set LUNAR_NETWORK_TESTS=1"),
]


def _spec(name):
    return next(s for s in remote_specs() if s.name == name)


def _local(name):
    label = DEM_DIR / f"{name}_float.lbl"
    if not label.exists():
        pytest.skip(f"{name} not downloaded")
    return DemProduct.open(label)


@pytest.fixture(scope="module")
def cache(tmp_path_factory):
    return tmp_path_factory.mktemp("lola_cache")


def test_remote_window_is_byte_identical_to_the_downloaded_file(cache):
    local = _local("ldem_75s_240m")
    far = open_remote(_spec("ldem_75s_240m"), cache)
    assert far.shape == local.shape
    assert far.projection == local.projection
    # Around the south pole (grid centre 1905.5), crossing block edges at 1792 and 2048.
    r0, c0 = 1750, 1760
    np.testing.assert_array_equal(far.data.window(r0, r0 + 300, c0, c0 + 300),
                                  np.asarray(local.data[r0:r0 + 300, c0:c0 + 300]))


def _patch(lat0, lon0, half=0.2, n=25):
    lat, lon = np.meshgrid(np.linspace(lat0 - half, lat0 + half, n), np.linspace(lon0 - half, lon0 + half, n))
    return lat.ravel(), lon.ravel()


@pytest.mark.parametrize("lat0, lon0", [(0.674, 23.473), (20.19, 30.77), (-45.44, 177.6)])
def test_ldem_512_agrees_with_ldem_16(cache, lat0, lon0):
    """Same LOLA data at 59 m and 1,895 m: they must agree where both resolve the terrain,
    and agree far better than with the patch mirrored in latitude (a placement bug)."""
    fine = open_remote(_spec("ldem_512"), cache)
    coarse = _local("ldem_16")
    lat, lon = _patch(lat0, lon0)
    h512, h16 = fine.heights_m(lat, lon), coarse.heights_m(lat, lon)
    wrong = fine.heights_m(-lat, lon)
    good, bad = np.median(np.abs(h512 - h16)), np.median(np.abs(wrong - h16))
    print(f"\n({lat0}, {lon0}): median |ldem_512 - ldem_16| = {good:.0f} m; mirrored {bad:.0f} m")
    assert np.isfinite(h512).all()
    assert good < 150 and bad > 3 * good


def test_ldem_512_is_continuous_across_a_tile_seam(cache):
    """Tiles 00N-45N/000-090 and 090-180 meet at 90E; heights 1 px either side differ
    only by terrain slope, not by a step."""
    fine = open_remote(_spec("ldem_512"), cache)
    lat = np.linspace(10.0, 10.3, 40)
    px = 1 / 512
    left = fine.heights_m(lat, np.full(40, 90 - 1.5 * px))
    seam = fine.heights_m(lat, np.full(40, 90.0))
    right = fine.heights_m(lat, np.full(40, 90 + 1.5 * px))
    assert np.isfinite(seam).all()
    step = np.abs(seam - (left + right) / 2)
    print(f"\nseam: max |h(90E) - mean(neighbours)| = {step.max():.1f} m")
    assert np.median(step) < 5.0


def test_ldem_80s_20m_agrees_with_ldem_75s_240m(cache):
    fine = open_remote(_spec("ldem_80s_20m"), cache)
    coarse = _local("ldem_75s_240m")
    lat, lon = _patch(-89.45, 222.69, half=0.05)
    h20, h240 = fine.heights_m(lat, lon), coarse.heights_m(lat, lon)
    wrong = fine.heights_m(lat, lon + 180)
    good, bad = np.median(np.abs(h20 - h240)), np.median(np.abs(wrong - h240))
    print(f"\nconnecting ridge: median |20 m - 240 m| = {good:.0f} m; rotated 180 deg {bad:.0f} m")
    assert good < 60 and bad > 3 * good


# ---------- SLDEM2015 (the site map below 60 deg) ----------


@pytest.mark.parametrize("lat0, lon0", [(0.674, 23.473), (20.19, 30.77), (-45.44, 177.6)])
def test_sldem2015_agrees_with_lola(cache, lat0, lon0):
    """SLDEM2015 is LOLA co-registered with Kaguya stereo, so it must agree closely with
    LOLA-only ldem_512 and ldem_16, and far better than with the patch mirrored."""
    sl = open_remote(_spec("sldem2015_512"), cache)
    l512 = open_remote(_spec("ldem_512"), cache)
    coarse = _local("ldem_16")
    lat, lon = _patch(lat0, lon0)
    hs, h512, h16 = sl.heights_m(lat, lon), l512.heights_m(lat, lon), coarse.heights_m(lat, lon)
    wrong = sl.heights_m(-lat, lon)
    d512, d16, bad = (np.median(np.abs(hs - h512)), np.median(np.abs(hs - h16)),
                      np.median(np.abs(wrong - h16)))
    print(f"\n({lat0}, {lon0}): median |SLDEM - ldem_512| = {d512:.1f} m, "
          f"|SLDEM - ldem_16| = {d16:.0f} m; mirrored {bad:.0f} m")
    assert np.isfinite(hs).all()
    assert d512 < 20 and d16 < 150 and bad > 3 * d16


@pytest.mark.parametrize("lat, lon, across", [
    (np.linspace(10.0, 10.3, 40), np.full(40, 45.0), "lon"),   # tile seam at 45E
    (np.full(40, 30.0), np.linspace(20.0, 20.3, 40), "lat"),   # band seam at 30N
])
def test_sldem2015_is_continuous_across_tile_seams(cache, lat, lon, across):
    sl = open_remote(_spec("sldem2015_512"), cache)
    px = 1.5 / 512
    if across == "lon":
        a, b = sl.heights_m(lat, lon - px), sl.heights_m(lat, lon + px)
    else:
        a, b = sl.heights_m(lat - px, lon), sl.heights_m(lat + px, lon)
    seam = sl.heights_m(lat, lon)
    step = np.abs(seam - (a + b) / 2)
    print(f"\nseam ({across}): max |h(seam) - mean(neighbours)| = {step.max():.1f} m")
    assert np.isfinite(seam).all() and np.median(step) < 5.0


def test_sldem2015_does_not_cover_beyond_60_degrees(cache):
    sl = open_remote(_spec("sldem2015_512"), cache)
    h = sl.heights_m(np.array([59.9, 60.2, -61.0, 75.0]), np.array([10.0, 10.0, 10.0, 10.0]))
    assert np.isfinite(h[0]) and np.isnan(h[1:]).all()

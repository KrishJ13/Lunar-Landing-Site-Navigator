"""Checks against the real LOLA files. Skipped unless they are downloaded:

    python scripts/fetch_dem.py --tier starter

The key test cross-checks two INDEPENDENT products: the global cylindrical
map and the south polar stereographic map. If our polar orientation or
scaling were wrong, the two would disagree badly where they overlap.
"""

import numpy as np
import pytest

from lunar.config import DEM_DIR
from lunar.dem import DemProduct

pytestmark = pytest.mark.real_data


def _open(name: str) -> DemProduct:
    label = DEM_DIR / f"{name}_float.lbl"
    if not label.exists():
        pytest.skip(f"{name} not downloaded (run scripts/fetch_dem.py --tier starter)")
    return DemProduct.open(label)


@pytest.fixture(scope="module")
def global_map():
    return _open("ldem_16")


@pytest.fixture(scope="module")
def south_map():
    return _open("ldem_75s_240m")


def test_heights_are_in_plausible_lunar_range(global_map):
    lat, lon = np.meshgrid(np.linspace(-89, 89, 60), np.linspace(0, 359, 120))
    h = global_map.heights_m(lat.ravel(), lon.ravel())
    # Lunar topography spans roughly -9 km to +11 km around the 1737.4 km sphere.
    assert np.nanmin(h) > -10_000 and np.nanmax(h) < 11_000
    assert np.isfinite(h).all()


def test_polar_and_global_maps_agree_where_they_overlap(global_map, south_map):
    rng = np.random.default_rng(0)
    lat = rng.uniform(-88.0, -77.0, 400)
    lon = rng.uniform(0.0, 360.0, 400)

    polar = south_map.heights_m(lat, lon)
    reference = global_map.heights_m(lat, lon)
    assert np.isfinite(polar).all()

    # Rotate the polar lookup by 180 deg: what a sign/orientation bug would look like.
    wrong = south_map.heights_m(lat, lon + 180.0)

    good_err = np.median(np.abs(polar - reference))
    bad_err = np.median(np.abs(wrong - reference))
    correlation = np.corrcoef(polar, reference)[0, 1]

    print(f"\nmedian |polar - global| = {good_err:.0f} m; "
          f"if mis-oriented = {bad_err:.0f} m; correlation = {correlation:.3f}")
    # The global map is ~1.9 km/pixel, so small-scale differences are expected,
    # but the large-scale terrain must match closely.
    assert correlation > 0.95
    assert good_err < 300
    assert bad_err > 3 * good_err

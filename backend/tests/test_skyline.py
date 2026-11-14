"""360-degree skyline tests on synthetic terrain."""

import numpy as np
import pytest

from lunar.config import MOON_RADIUS_M as R
from lunar.dem import DemProduct
from lunar.horizon import horizon_ray
from lunar.skyline import azimuth_grid, compute_skyline


@pytest.fixture
def flat_moon(make_cylindrical):
    return [DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat))]


@pytest.fixture
def plateau_moon(make_cylindrical, make_polar):
    """Smooth Moon plus a 1 km plateau for x > 20 km (towards 90E) near the south pole."""
    background = DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat))
    plateau = DemProduct.open(make_polar(lambda x, y: np.where(x > 20_000, 1.0, 0.0), n=201, scale_m=500.0))
    return [background, plateau]


def test_azimuth_grid():
    grid = azimuth_grid(0.5)
    assert len(grid) == 720 and grid[0] == 0 and grid[-1] == 359.5


def test_one_profile_per_height_with_full_circle(flat_moon):
    profiles = compute_skyline(flat_moon, 10, 20, heights_above_ground_m=(2, 10, 50),
                               azimuth_step_deg=5, min_step_m=50)
    assert [p.height_above_ground_m for p in profiles] == [2, 10, 50]
    for p in profiles:
        assert p.azimuth_deg.shape == p.elevation_deg.shape == p.distance_m.shape == (72,)


def test_flat_moon_skyline_is_level_all_around(flat_moon):
    (p,) = compute_skyline(flat_moon, -45, 100, heights_above_ground_m=(10,), azimuth_step_deg=10, min_step_m=20)
    expected = -np.degrees(np.arccos(R / (R + 10)))
    np.testing.assert_allclose(p.elevation_deg, expected, rtol=1e-3)
    np.testing.assert_allclose(p.distance_m, np.sqrt(2 * R * 10), rtol=0.02)
    assert not p.at_max_range.any()


def test_plateau_is_seen_only_towards_the_east(plateau_moon):
    (p,) = compute_skyline(plateau_moon, -90, 0, azimuth_step_deg=1, min_step_m=50)
    east = p.elevation_deg[p.azimuth_deg == 90][0]
    west = p.elevation_deg[p.azimuth_deg == 270][0]
    assert east > 2.0  # the 1 km wall 20 km away is ~2.7 deg up
    assert west < 0  # nothing but the smooth horizon behind
    # Wall spans x > 20 km at every y, so it fills a wide arc around east.
    assert (p.elevation_deg[(p.azimuth_deg > 60) & (p.azimuth_deg < 120)] > 1.0).all()


def test_matches_single_ray_component(plateau_moon):
    (p,) = compute_skyline(plateau_moon, -90, 0, azimuth_step_deg=30, min_step_m=50)
    for az, el, dist in zip(p.azimuth_deg, p.elevation_deg, p.distance_m):
        _, _, point = horizon_ray(plateau_moon, -90, 0, az, min_step_m=50)
        assert el == pytest.approx(point.elevation_deg, abs=1e-9)
        assert dist == pytest.approx(point.distance_m)


def test_taller_observer_never_sees_a_higher_skyline(plateau_moon):
    low, high = compute_skyline(plateau_moon, -90, 0, heights_above_ground_m=(2, 100),
                                azimuth_step_deg=5, min_step_m=50)
    assert (high.elevation_deg <= low.elevation_deg + 1e-9).all()

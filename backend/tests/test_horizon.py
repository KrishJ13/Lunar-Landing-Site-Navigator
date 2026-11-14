"""Horizon ray tests on synthetic terrain with answers known from first principles."""

import numpy as np
import pytest

from lunar.config import MOON_RADIUS_M as R
from lunar.dem import DemProduct
from lunar.horizon import (
    horizon_point,
    horizon_ray,
    make_observer,
    ray_profile,
    sample_distances,
    side_view,
    visible_mask,
)


@pytest.fixture
def flat_moon(make_cylindrical):
    """A perfectly smooth Moon: height 0 everywhere."""
    return [DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat))]


@pytest.fixture
def plateau_moon(make_cylindrical, make_polar):
    """Smooth Moon, plus a 1 km high plateau east of the south pole.

    In the polar map, x is metres towards longitude 90E. Everything with
    x > 20 km is raised by 1 km, so an observer at the pole looking east
    (azimuth 90, relative to meridian 0) faces a wall 20 km away.
    """
    background = DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat))
    plateau = DemProduct.open(
        make_polar(lambda x, y: np.where(x > 20_000, 1.0, 0.0), n=201, scale_m=500.0)
    )
    return [background, plateau]


class TestSampleDistances:
    def test_spacing(self):
        d = sample_distances(max_range_m=200_000, min_step_m=100, relative_step=0.01)
        steps = np.diff(d)
        assert d[0] == 100 and d[-1] == 200_000
        assert (steps > 0).all()
        assert steps[:-1].min() >= 100 - 1e-9
        # far away, steps grow with distance
        assert steps[-2] == pytest.approx(0.01 * d[-3], rel=0.02)

    def test_sample_count_stays_modest(self):
        assert len(sample_distances(200_000, 10, 0.005)) < 2_500


class TestFlatMoon:
    """On a smooth sphere the horizon is the classic geometric one:
    dip = acos(R / (R + h)) below horizontal, at distance sqrt(2 R h)."""

    @pytest.mark.parametrize("h", [2.0, 10.0, 50.0])
    def test_horizon_dip_and_distance(self, flat_moon, h):
        _, _, point = horizon_ray(flat_moon, 10.0, 20.0, 45.0, height_above_ground_m=h, min_step_m=10.0)
        expected_dip = np.degrees(np.arccos(R / (R + h)))
        assert point.elevation_deg == pytest.approx(-expected_dip, rel=1e-3)
        assert point.distance_m == pytest.approx(np.sqrt(2 * R * h), rel=0.02)
        assert not point.at_max_range

    def test_too_short_range_is_flagged(self, flat_moon):
        _, _, point = horizon_ray(flat_moon, 0, 0, 0, height_above_ground_m=2.0, max_range_m=1_000, min_step_m=10)
        assert point.at_max_range

    def test_side_view_shows_curvature(self, flat_moon):
        observer, profile, _ = horizon_ray(flat_moon, 0, 0, 0, height_above_ground_m=2.0, min_step_m=1_000)
        forward, up = side_view(profile, observer)
        # A surface point at central angle delta = d / R sits at
        #   forward = R sin(delta),  up = R cos(delta) - (R + h)
        # i.e. it drops below the eye by roughly h + d^2 / 2R.
        delta = profile.distance_m / R
        np.testing.assert_allclose(forward, R * np.sin(delta), rtol=1e-9)
        np.testing.assert_allclose(up, R * np.cos(delta) - (R + 2.0), rtol=1e-9)
        assert up[-1] == pytest.approx(-(2.0 + 200_000**2 / (2 * R)), rel=5e-3)


class TestPlateau:
    def test_skyline_is_the_plateau_edge(self, plateau_moon):
        _, _, point = horizon_ray(plateau_moon, -90.0, 0.0, 90.0, height_above_ground_m=2.0, min_step_m=50.0)
        # The edge is smoothed over one 500 m pixel by interpolation.
        assert 20_000 <= point.distance_m <= 21_000
        approx = np.degrees(np.arctan((1000 - 2) / point.distance_m) - point.distance_m / (2 * R))
        assert point.elevation_deg == pytest.approx(approx, abs=0.05)
        assert point.terrain_m == pytest.approx(1000, abs=1)

    def test_looking_away_from_plateau_sees_flat_horizon(self, plateau_moon):
        _, _, point = horizon_ray(plateau_moon, -90.0, 0.0, 270.0, height_above_ground_m=2.0, min_step_m=50.0)
        assert point.elevation_deg == pytest.approx(-np.degrees(np.arccos(R / (R + 2))), rel=1e-2)

    def test_visible_mask(self, plateau_moon):
        _, profile, point = horizon_ray(plateau_moon, -90.0, 0.0, 90.0, height_above_ground_m=2.0, min_step_m=50.0)
        seen = visible_mask(profile)

        def at(d):
            return seen[np.argmin(np.abs(profile.distance_m - d))]

        assert at(1_000)  # nearby flat ground
        assert not at(10_000)  # flat ground beyond the 2.6 km geometric horizon
        assert at(20_250)  # the face of the wall, rising towards the edge
        assert at(point.distance_m)  # the skyline point itself
        assert not at(40_000)  # plateau top behind its own edge

    def test_higher_observer_sees_the_wall_lower(self, plateau_moon):
        low = horizon_ray(plateau_moon, -90.0, 0.0, 90.0, height_above_ground_m=2.0, min_step_m=50.0)[2]
        high = horizon_ray(plateau_moon, -90.0, 0.0, 90.0, height_above_ground_m=200.0, min_step_m=50.0)[2]
        assert high.elevation_deg < low.elevation_deg


def test_profile_records_which_map_was_used(plateau_moon):
    observer = make_observer(plateau_moon, -90.0, 0.0)
    assert observer.site_pixel_size_m == 500.0
    profile = ray_profile(plateau_moon, observer, 90.0, np.array([1_000.0, 500_000.0]))
    assert profile.pixel_size_m[0] == 500.0  # near the pole: polar map
    assert profile.pixel_size_m[1] > 7_000  # 500 km out: global map
    assert horizon_point(profile).azimuth_deg == 90.0

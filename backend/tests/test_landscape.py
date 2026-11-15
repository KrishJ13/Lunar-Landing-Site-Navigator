"""Visible-landscape tests on synthetic terrain."""

import numpy as np
import pytest

from lunar.dem import DemProduct
from lunar.geometry import enu_basis, geometric_horizon
from lunar.landscape import SEGMENT_FIELDS, compute_view, strip_segments, terrain_normals


@pytest.fixture
def plateau_moon(make_cylindrical, make_polar):
    """Smooth Moon plus a 1 km plateau for x > 20 km (towards 90E) near the south pole."""
    background = DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat))
    plateau = DemProduct.open(make_polar(lambda x, y: np.where(x > 20_000, 1.0, 0.0), n=201, scale_m=500.0))
    return [background, plateau]


def test_segment_fields():
    assert SEGMENT_FIELDS[-1] == "height_m" and len(SEGMENT_FIELDS) == 7


class TestStripSegments:
    def test_hand_worked_example(self):
        # angles along a ray: rises, dips (hidden), then a far peak appears
        el = np.array([-5.0, -3.0, -4.0, -3.5, -1.0, -2.0])
        dist = np.array([100.0, 200, 300, 400, 5000, 6000])
        shade = np.array([0.5, 0.9, 0.5, 0.5, 0.7, 0.5])
        height = np.array([10.0, 20, 15, 18, 900, 800])
        seg = strip_segments(el, dist, shade, height)
        # visible: 0 (-5), 1 (-3), then 4 (-1) after hidden samples 2 and 3
        np.testing.assert_allclose(seg[:, :2], [[-90, -5], [-5, -3], [-3, -1]])
        np.testing.assert_allclose(seg[:, 2:4], [[0, 0.1], [0.1, 0.2], [5.0, 5.0]])
        np.testing.assert_allclose(seg[:, 5], [0, 0, 1])  # silhouette edge before the far peak
        np.testing.assert_allclose(seg[:, 6], [10, 20, 900])  # terrain height at each segment top

    def test_close_distances_merge_far_ones_split(self):
        el = np.array([-5.0, -4.0, -3.0, -2.0])
        dist = np.array([1000.0, 1200, 1400, 3000])  # 1.2 and 1.4 km merge into 1 km; 3 km does not
        seg = strip_segments(el, dist, np.full(4, 0.5), np.zeros(4))
        assert seg.shape == (2, 7)
        assert seg[0, 1] == -3.0 and seg[0, 3] == pytest.approx(1.4)
        assert seg[1, 2] == pytest.approx(1.4) and seg[1, 3] == pytest.approx(3.0)


class TestComputeView:
    def test_strips_are_contiguous_and_end_at_skyline(self, plateau_moon):
        view = compute_view(plateau_moon, -90, 0, 2.0, azimuth_step_deg=10, min_step_m=50)
        sky, land = view.skyline, view.landscape
        for az, seg, top in zip(land.azimuth_deg, land.segments, sky.elevation_deg):
            assert seg[0, 0] == -90.0
            np.testing.assert_allclose(seg[1:, 0], seg[:-1, 1])  # no gaps
            assert seg[-1, 1] == pytest.approx(top), az
            assert (np.diff(seg[:, 1]) > 0).all()

    def test_wall_appears_behind_hidden_flat_ground(self, plateau_moon):
        land = compute_view(plateau_moon, -90, 0, 2.0, azimuth_step_deg=10, min_step_m=50).landscape
        east = land.segments[list(land.azimuth_deg).index(90.0)]
        walls = east[east[:, 5] == 1]
        assert len(walls) == 1
        assert 19.5 <= walls[0, 2] <= 21.0  # emerges ~20 km away
        assert walls[0, 1] > 2.0  # rises to the ~2.7 deg wall top
        assert east[-1, 6] == pytest.approx(1000, abs=1)  # top of the wall is 1 km above mean level

    def test_open_ground_ends_at_geometric_horizon(self, plateau_moon):
        land = compute_view(plateau_moon, -90, 0, 2.0, azimuth_step_deg=10, min_step_m=50).landscape
        west = land.segments[list(land.azimuth_deg).index(270.0)]
        assert (west[:, 5] == 0).all()  # nothing behind a ridge
        assert west[-1, 1] == pytest.approx(-geometric_horizon(2.0)["dip_deg"], rel=1e-2)


class TestTerrainNormals:
    def test_flat_ground_normal_is_up(self, plateau_moon):
        n = terrain_normals(plateau_moon, np.array([-89.0]), np.array([45.0]), 500.0)
        up = np.array([np.cos(np.radians(-89)) * np.cos(np.radians(45)),
                       np.cos(np.radians(-89)) * np.sin(np.radians(45)), np.sin(np.radians(-89))])
        np.testing.assert_allclose(n[0], up, atol=1e-9)

    def test_slope_tilts_normal_downhill(self, make_cylindrical, make_polar):
        # Height rises 1 m per 100 m towards map-x, i.e. towards longitude 90E,
        # which is the Moon-fixed +y axis.
        products = [
            DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat)),
            DemProduct.open(make_polar(lambda x, y: x * 1e-5, n=201, scale_m=500.0)),
        ]
        n = terrain_normals(products, np.array([-89.9]), np.array([90.0]), 500.0)[0]
        # At (89.9S, 90E), local north points away from the pole, i.e. along
        # map-x, so the ground rises to the north with slope 0.01. Compare in
        # the local frame: the normal leans south by atan(0.01).
        east, north, up = enu_basis(-89.9, 90.0)
        assert np.dot(n, north) == pytest.approx(-0.01 / np.sqrt(1 + 0.01**2), abs=1e-4)
        assert np.dot(n, east) == pytest.approx(0.0, abs=1e-6)
        assert np.dot(n, up) == pytest.approx(1 / np.sqrt(1 + 0.01**2), abs=1e-6)


def test_mean_level_line(plateau_moon):
    # Observer stands on mean level (height 0) with eyes 2 m up. Looking west
    # the skyline is smooth ground at height 0, so the mean-level line and the
    # skyline coincide; looking east the 1 km wall stands above the line.
    view = compute_view(plateau_moon, -90, 0, 2.0, azimuth_step_deg=90, min_step_m=50)
    az = list(view.skyline.azimuth_deg)
    west, east = az.index(270.0), az.index(90.0)
    assert view.mean_level_elevation_deg[west] == pytest.approx(view.skyline.elevation_deg[west], abs=1e-6)
    assert view.skyline.elevation_deg[east] - view.mean_level_elevation_deg[east] > 2.0

"""Crest finder tests: synthetic terrain checked against a brute-force reference."""

import numpy as np
import pytest

from lunar.config import MOON_RADIUS_M as R
from lunar.dem import DemProduct, heights_at
from lunar.geometry import destination, geometric_horizon, look_angles, surface_vector
from lunar.ridges import compute_crests, find_crests


def gaussian_ridges(near_km=0.3, far_km=3.0):
    """Two ridges running north-south (constant along map-y), east of the pole:
    a near one 10 km away and a far, taller one 40 km away. Heights in km."""

    def fn(x, y):
        return near_km * np.exp(-(((x - 10_000) / 1_500) ** 2)) + far_km * np.exp(-(((x - 40_000) / 4_000) ** 2))

    return fn


@pytest.fixture
def ridge_moon(make_cylindrical, make_polar):
    def build(**kw):
        return [
            DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat)),
            DemProduct.open(make_polar(gaussian_ridges(**kw), n=241, scale_m=500.0)),
        ]

    return build


def brute_force_maxima(products, observer, azimuth, step_m=5.0, max_m=60_000.0):
    """Reference: local maxima of the elevation angle on a 5 m grid (bicubic)."""
    d = np.arange(step_m, max_m, step_m)
    lat, lon = destination(observer.lat, observer.lon, azimuth, d)
    h, _ = heights_at(products, lat, lon, method="bicubic")
    _, el, _ = look_angles(observer.position, surface_vector(lat, lon, h), observer.basis)
    i = np.flatnonzero((el[1:-1] > el[:-2]) & (el[1:-1] >= el[2:])) + 1
    return d[i], el[i]


class TestFindCrests:
    def test_simple_profile(self):
        d = np.arange(1.0, 11.0)
        el = np.array([0, 1, 2, 1, 0, 3, 4, 5, 4, 3], dtype=float)
        crests = find_crests(d, el, min_dip_deg=0.5)
        assert [round(c[0], 3) for c in crests] == [3.0, 8.0]
        assert [c[3] for c in crests] == [False, True]  # the far one is the skyline

    def test_parabola_refines_between_samples(self):
        d = np.arange(0.0, 10.0)
        el = -((d - 4.3) ** 2)  # true maximum at 4.3, between samples
        (crest,) = find_crests(d, el)
        assert crest[0] == pytest.approx(4.3, abs=1e-9)
        assert crest[1] == pytest.approx(0.0, abs=1e-9)

    def test_hidden_crest_is_dropped(self):
        d = np.arange(1.0, 9.0)
        el = np.array([0, 5, 1, 2, 3, 2, 1, 0], dtype=float)  # second bump never rises above 5
        crests = find_crests(d, el)
        assert len(crests) == 1 and crests[0][0] == pytest.approx(2.0, abs=0.5)

    def test_falling_from_the_start_gives_nearest_as_skyline(self):
        d = np.arange(1.0, 6.0)
        el = np.array([-1.0, -2, -3, -4, -5])  # standing on a summit: everything falls away
        crests = find_crests(d, el)
        assert len(crests) == 1 and crests[0][0] == 1.0 and crests[0][3]

    def test_small_ripple_is_ignored(self):
        d = np.arange(1.0, 9.0)
        el = np.array([0, 1, 2.0, 1.995, 3, 4, 3, 2], dtype=float)  # 0.005 deg dip after 2.0
        crests = find_crests(d, el, min_dip_deg=0.01)
        assert len(crests) == 1 and crests[0][3]


class TestComputeCrests:
    def test_smooth_moon_crest_is_the_geometric_horizon(self, make_cylindrical):
        products = [DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat))]
        view = compute_crests(products, 10, 20, 1.8, azimuth_step_deg=45, min_step_m=20)
        exact = geometric_horizon(1.8)
        for crests in view.crests:
            assert len(crests) == 1
            dist, el = crests[0][0], crests[0][1]
            assert el == pytest.approx(-exact["dip_deg"], abs=1e-4)
            assert dist == pytest.approx(exact["surface_distance_m"], rel=0.05)

    def test_two_ridges_match_brute_force(self, ridge_moon):
        products = ridge_moon()
        view = compute_crests(products, -90, 0, 2.0, azimuth_step_deg=90, min_step_m=250)
        east = view.crests[list(view.azimuth_deg).index(90.0)]
        ref_d, ref_el = brute_force_maxima(products, view.observer, 90.0)
        visible = [(d, e) for d, e in zip(ref_d, ref_el) if d > 5_000]
        # 3 crests: the plain's own horizon (~2.6 km), the near ridge, the far mountain
        assert len(east) == 3
        assert east[0, 0] == pytest.approx(geometric_horizon(2.0)["surface_distance_m"], rel=0.05)
        for (dist, el), (rd, re) in zip(east[1:, :2], visible):
            assert el == pytest.approx(re, abs=0.002)  # angle to within 0.002 deg (7 arcsec)
            assert dist == pytest.approx(rd, rel=0.02)
        assert list(east[:, 5]) == [0, 0, 1]  # far mountain is the skyline
        # heights at the crests: near ridge ~300 m, far mountain ~3 km
        assert east[1, 2] == pytest.approx(300, rel=0.05)
        assert east[2, 2] == pytest.approx(3000, rel=0.05)

    def test_expected_angles_from_first_principles(self, ridge_moon):
        view = compute_crests(ridge_moon(), -90, 0, 2.0, azimuth_step_deg=90, min_step_m=250)
        east = view.crests[list(view.azimuth_deg).index(90.0)]
        # near ridge: atan((300 - 2) / 10 km) - (10 km / 2R) ~ 1.54 deg
        approx_near = np.degrees(np.arctan(298 / 10_000) - 10_000 / (2 * R))
        assert east[1, 1] == pytest.approx(approx_near, abs=0.05)

    def test_lower_far_ridge_is_hidden(self, ridge_moon):
        view = compute_crests(ridge_moon(far_km=0.5), -90, 0, 2.0, azimuth_step_deg=90, min_step_m=250)
        east = view.crests[list(view.azimuth_deg).index(90.0)]
        assert len(east) == 2 and list(east[:, 5]) == [0, 1]  # plain horizon, then near ridge = skyline
        assert east[1, 0] == pytest.approx(10_000, rel=0.05)

    def test_opposite_direction_sees_smooth_horizon(self, ridge_moon):
        view = compute_crests(ridge_moon(), -90, 0, 2.0, azimuth_step_deg=90, min_step_m=50)
        west = view.crests[list(view.azimuth_deg).index(270.0)]
        assert len(west) == 1
        assert west[0, 1] == pytest.approx(-geometric_horizon(2.0)["dip_deg"], abs=1e-3)


def test_visible_profile_marks_terrain_behind_a_ridge():
    from lunar.ridges import visible_profile

    d = np.array([100.0, 200, 300, 400, 5000, 6000])
    el = np.array([-5.0, -3.0, -4.0, -3.5, -1.0, -2.0])
    prof = visible_profile(d, el)
    # visible: samples 0, 1, then 4 (after hidden 2 and 3) which is behind the ridge
    np.testing.assert_allclose(prof[:, 0], [-5, -3, -1])
    np.testing.assert_allclose(prof[:, 2], [0, 0, 1])

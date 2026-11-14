import numpy as np
import pytest

from lunar.config import MOON_RADIUS_M as R
from lunar.geometry import (
    destination,
    enu_basis,
    horizontal_direction,
    look_angles,
    surface_vector,
    vector_to_latlon,
)

AU_M = 149_597_870_700.0


class TestSurfaceVector:
    @pytest.mark.parametrize(
        "lat, lon, expected",
        [
            (0, 0, (R, 0, 0)),
            (0, 90, (0, R, 0)),
            (90, 0, (0, 0, R)),
            (-90, 123, (0, 0, -R)),
        ],
    )
    def test_axes(self, lat, lon, expected):
        np.testing.assert_allclose(surface_vector(lat, lon), expected, atol=1e-6)

    def test_height_extends_radius(self):
        v = surface_vector(10, 20, 1500.0)
        assert np.linalg.norm(v) == pytest.approx(R + 1500.0)

    def test_round_trip_with_arrays(self):
        lat = np.array([-89.45, -30.0, 0.0, 45.0])
        lon = np.array([222.69, 10.0, 359.0, 180.0])
        h = np.array([1951.0, -2000.0, 0.0, 300.0])
        back = vector_to_latlon(surface_vector(lat, lon, h))
        np.testing.assert_allclose(back[0], lat, atol=1e-9)
        np.testing.assert_allclose(back[1], lon, atol=1e-9)
        np.testing.assert_allclose(back[2], h, atol=1e-6)


class TestEnuBasis:
    @pytest.mark.parametrize("lat, lon", [(0, 0), (-89.45, 222.69), (45, -60), (-90, 0), (90, 30)])
    def test_orthonormal_and_right_handed(self, lat, lon):
        e, n, u = enu_basis(lat, lon)
        for v in (e, n, u):
            assert np.linalg.norm(v) == pytest.approx(1.0)
        assert np.dot(e, n) == pytest.approx(0, abs=1e-12)
        assert np.dot(e, u) == pytest.approx(0, abs=1e-12)
        assert np.dot(n, u) == pytest.approx(0, abs=1e-12)
        np.testing.assert_allclose(np.cross(e, n), u, atol=1e-12)

    def test_north_points_towards_north_pole(self):
        _, n, _ = enu_basis(-45, 100)
        assert n[2] > 0

    def test_at_south_pole_north_follows_given_meridian(self):
        _, n, _ = enu_basis(-90, 0)
        np.testing.assert_allclose(n, (1, 0, 0), atol=1e-12)  # towards lon 0
        _, n, _ = enu_basis(-90, 90)
        np.testing.assert_allclose(n, (0, 1, 0), atol=1e-12)  # towards lon 90

    def test_horizontal_direction_compass_points(self):
        e, n, _ = enu_basis(20, 30)
        np.testing.assert_allclose(horizontal_direction(20, 30, 0), n, atol=1e-12)
        np.testing.assert_allclose(horizontal_direction(20, 30, 90), e, atol=1e-12)
        np.testing.assert_allclose(horizontal_direction(20, 30, 180), -n, atol=1e-12)


class TestDestination:
    def test_quarter_circle_north_from_equator_reaches_pole(self):
        lat, _ = destination(0, 0, 0, np.pi * R / 2)
        assert lat == pytest.approx(90)

    def test_quarter_circle_east_along_equator(self):
        lat, lon = destination(0, 0, 90, np.pi * R / 2)
        assert (lat, lon) == (pytest.approx(0, abs=1e-9), pytest.approx(90))

    def test_from_south_pole(self):
        # North (meridian 0) and East (towards lon 90), 1 degree of arc away.
        one_deg = np.radians(1) * R
        lat, lon = destination(-90, 0, 0, one_deg)
        assert (lat, lon) == (pytest.approx(-89), pytest.approx(0, abs=1e-9))
        lat, lon = destination(-90, 0, 90, one_deg)
        assert (lat, lon) == (pytest.approx(-89), pytest.approx(90))

    def test_distance_and_heading_are_preserved(self):
        lat0, lon0, az, dist = -89.45, 222.69, 37.0, 50_000.0
        lat, lon = destination(lat0, lon0, az, dist)
        a, b = surface_vector(lat0, lon0), surface_vector(lat, lon)
        arc = R * np.arccos(np.dot(a, b) / (R * R))
        assert arc == pytest.approx(dist, rel=1e-9)
        # The start of the path heads in the requested direction.
        lat_s, lon_s = destination(lat0, lon0, az, 1.0)
        got_az, _, _ = look_angles(a, surface_vector(lat_s, lon_s), enu_basis(lat0, lon0))
        assert got_az == pytest.approx(az, abs=1e-4)

    def test_vectorised_over_azimuths(self):
        az = np.arange(0, 360, 45.0)
        lat, lon = destination(-89.45, 222.69, az, 10_000.0)
        assert lat.shape == lon.shape == az.shape


class TestLookAngles:
    def test_straight_up_is_90_degrees(self):
        obs = surface_vector(10, 20)
        _, el, rng = look_angles(obs, surface_vector(10, 20, 1000.0), enu_basis(10, 20))
        assert el == pytest.approx(90)
        assert rng == pytest.approx(1000.0)

    def test_surface_point_dips_by_half_the_arc(self):
        # Curvature: a point on a smooth sphere a distance d away appears
        # below the horizontal by half the central angle, (d / R) / 2.
        obs = surface_vector(-89.45, 222.69)
        basis = enu_basis(-89.45, 222.69)
        for d in (2_600.0, 50_000.0, 150_000.0):
            lat, lon = destination(-89.45, 222.69, 60.0, d)
            az, el, _ = look_angles(obs, surface_vector(lat, lon), basis)
            assert el == pytest.approx(-np.degrees(d / R) / 2, abs=1e-9)
            assert az == pytest.approx(60.0, abs=1e-6)

    def test_matches_jpl_horizons_for_sun_and_earth(self):
        # Horizons query at 2026-12-01 00:00 UT (fetched 2026-11-14):
        #  geocentric Moon table: sub-solar (lon 280.063976, lat -1.470809),
        #  Sun range 0.986331844173 au; sub-Earth (lon 6.669340, lat 1.345975),
        #  Earth range 0.00251635544404 au.
        #  topocentric from site (lat -89.45, lon 222.69, h 0):
        #  Sun az 57.386895 el 1.766619; Earth az 143.970670 el -2.054944.
        site = surface_vector(-89.45, 222.69)
        basis = enu_basis(-89.45, 222.69)
        sun = (AU_M * 0.986331844173) * surface_vector(-1.470809, 280.063976, radius_m=1.0)
        earth = (AU_M * 0.00251635544404) * surface_vector(1.345975, 6.669340, radius_m=1.0)
        az, el, _ = look_angles(site, np.stack([sun, earth]), basis)
        np.testing.assert_allclose(az, [57.386895, 143.970670], atol=1e-3)
        np.testing.assert_allclose(el, [1.766619, -2.054944], atol=1e-3)

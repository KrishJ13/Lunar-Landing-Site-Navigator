import numpy as np
import pytest

from lunar.dem.projections import PolarStereographic, SimpleCylindrical, wrap_longitude

# Parameters copied from the real LOLA labels.
LDEM_16 = SimpleCylindrical(
    lines=2880, samples=5760, pixels_per_degree=16, center_lat=0, center_lon=180,
    line_offset=1439.5, sample_offset=2879.5, west_lon=0, east_lon=360,
)
LDEM_75S_240M = PolarStereographic(
    size=3812, meters_per_pixel=240, center_lat=-90, line_offset=1905.5, sample_offset=1905.5,
)
LDEM_75N_240M = PolarStereographic(
    size=3812, meters_per_pixel=240, center_lat=90, line_offset=1905.5, sample_offset=1905.5,
)


def test_wrap_longitude():
    assert wrap_longitude(-90) == 270
    assert wrap_longitude(360) == 0
    assert wrap_longitude(190, west=-180) == -170


class TestSimpleCylindrical:
    def test_image_corners_are_pixel_edges(self):
        line, sample = LDEM_16.latlon_to_pixel(90, 0)
        assert (line, sample) == (-0.5, -0.5)  # top-left edge of the image
        line, sample = LDEM_16.latlon_to_pixel(-90, 359.999999)
        assert line == pytest.approx(2879.5)
        assert sample == pytest.approx(5759.5, abs=1e-3)

    def test_centre_of_map(self):
        assert LDEM_16.latlon_to_pixel(0, 180) == (1439.5, 2879.5)

    def test_negative_longitudes_wrap(self):
        assert LDEM_16.latlon_to_pixel(10, -90) == LDEM_16.latlon_to_pixel(10, 270)

    def test_round_trip(self):
        lat = np.array([-89.9, -45.0, 0.0, 12.3, 89.9])
        lon = np.array([0.1, 90.0, 180.0, 300.5, 359.9])
        back_lat, back_lon = LDEM_16.pixel_to_latlon(*LDEM_16.latlon_to_pixel(lat, lon))
        np.testing.assert_allclose(back_lat, lat, atol=1e-9)
        np.testing.assert_allclose(back_lon, lon, atol=1e-9)


class TestPolarStereographic:
    def test_pole_is_image_centre(self):
        assert LDEM_75S_240M.latlon_to_pixel(-90, 0) == (1905.5, 1905.5)

    def test_south_orientation_lon0_up_lon90_right(self):
        line, sample = LDEM_75S_240M.latlon_to_pixel(-85, 0)
        assert line < 1905.5 and sample == pytest.approx(1905.5)
        line, sample = LDEM_75S_240M.latlon_to_pixel(-85, 90)
        assert sample > 1905.5 and line == pytest.approx(1905.5)

    def test_north_orientation_lon0_down_lon90_right(self):
        line, sample = LDEM_75N_240M.latlon_to_pixel(85, 0)
        assert line > 1905.5 and sample == pytest.approx(1905.5)
        line, sample = LDEM_75N_240M.latlon_to_pixel(85, 90)
        assert sample > 1905.5 and line == pytest.approx(1905.5)

    def test_map_edge_reaches_75_degrees(self):
        # The label says this 3812-pixel map extends to about 75S at its edges.
        line, _ = LDEM_75S_240M.latlon_to_pixel(-75, 0)
        assert line == pytest.approx(-0.5, abs=1.0)

    def test_distance_from_pole_matches_stereographic_formula(self):
        line, sample = LDEM_75S_240M.latlon_to_pixel(-89, 45)
        r_px = np.hypot(line - 1905.5, sample - 1905.5)
        expected_m = 2 * 1_737_400 * np.tan(np.radians(1.0) / 2)
        assert r_px * 240 == pytest.approx(expected_m)

    @pytest.mark.parametrize("proj", [LDEM_75S_240M, LDEM_75N_240M])
    def test_round_trip(self, proj):
        sign = -1 if proj.is_south else 1
        lat = sign * np.array([89.99, 88.0, 85.0, 80.0, 76.0])
        lon = np.array([0.0, 45.0, 135.0, 222.69, 359.0])
        back_lat, back_lon = proj.pixel_to_latlon(*proj.latlon_to_pixel(lat, lon))
        np.testing.assert_allclose(back_lat, lat, atol=1e-9)
        np.testing.assert_allclose(back_lon, lon, atol=1e-7)

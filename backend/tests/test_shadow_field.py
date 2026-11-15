"""Ray-march shadows over nested height grids (lunar.shadow_field)."""

import numpy as np
import pytest

from lunar.config import MOON_RADIUS_M as R
from lunar.shadow_field import NO_DATA, build_field, heights, march_lit_fraction

RADIUS = np.radians(0.2666)


def _sun(azimuth_deg, elevation_deg):
    a, e = np.radians(azimuth_deg), np.radians(elevation_deg)
    return np.array([np.cos(e) * np.sin(a), np.cos(e) * np.cos(a), np.sin(e)])


def test_heights_are_quantised_to_well_under_a_metre():
    field = build_field(lambda lat, lon: 1000.0 * np.sin(np.radians(lon) * 50), 0.0, 0.0,
                        levels=(5_000.0, 50_000.0), size=128)
    g = field[0]
    assert g["scale_m"] < 0.05 and int(g["q"].max()) < NO_DATA
    # Bilinear at a texel centre returns that texel's height.
    x = np.array([-5_000 + 0.5 * g["spacing_m"]])
    assert heights(field, x, x)[0] == pytest.approx(g["lo_m"] + g["q"][0, 0] * g["scale_m"])


def test_bare_sphere_sun_above_and_below_the_horizon():
    field = build_field(lambda lat, lon: np.zeros_like(lat), 0.0, 0.0, levels=(5_000.0, 400_000.0), size=128)
    x = np.array([0.0, 1_000.0, -3_000.0])
    assert np.all(march_lit_fraction(field, x, x, _sun(90, 1.0), RADIUS) == 1.0)
    assert np.all(march_lit_fraction(field, x, x, _sun(90, -1.0), RADIUS) == 0.0)
    # Sun centre near the level: on a smooth sphere the horizon is the ground just ahead
    # (0 deg, dropping away), so the visible part is the circular segment above each
    # point's OWN level; its vertical is tilted from the site's by distance / R.
    s = _sun(90, 0.0)
    lit = march_lit_fraction(field, x, x, s, RADIUS)
    rho = np.hypot(x, x)
    up = np.stack([np.sin(rho / R) * np.where(rho > 0, x / np.maximum(rho, 1), 0) for _ in range(2)] +
                  [np.cos(rho / R)], axis=-1)
    u = np.clip(np.arcsin(up @ s) / RADIUS, -1, 1)
    np.testing.assert_allclose(lit, 1 - (np.arccos(u) - u * np.sqrt(1 - u * u)) / np.pi, atol=0.02)


def test_a_wall_casts_a_shadow_of_the_expected_length():
    # A 500 m high wall 2 km east of the site, the Sun low in the east at 5 deg:
    # the shadow reaches 500 m / tan(5 deg) = 5.7 km west of the wall, to x = -3.7 km
    # (curvature shortens it by about 0.1 km).
    def wall(lat, lon):
        x = np.radians(lon) * R * np.cos(np.radians(lat))
        x = np.where(x > np.pi * R, x - 2 * np.pi * R, x)  # longitude 359.9 is just west
        return np.where(np.abs(x - 2_000) < 60, 500.0, 0.0)

    field = build_field(wall, 0.0, 0.0, levels=(12_000.0, 400_000.0), size=1024)
    east = np.array([1_000.0, -2_000.0, -3_400.0, -4_000.0, -7_000.0])
    lit = march_lit_fraction(field, east, np.zeros_like(east), _sun(90, 5.0), RADIUS)
    np.testing.assert_array_equal(lit, [0, 0, 0, 1, 1])

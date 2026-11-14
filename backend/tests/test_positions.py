import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest
import spiceypy as sp

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lunar_sky.__main__ import main
from lunar_sky.kernels import MOON_FRAME, load_kernels
from lunar_sky.positions import calculate_positions, enu_basis, observer_position_km

T = "2027-03-14T12:00:00Z"


@pytest.fixture(scope="module", autouse=True)
def loaded():
    load_kernels()
    yield
    sp.kclear()


def direction(az, el, enu):
    """Moon-fixed unit vector for an (azimuth, elevation) pair in a given ENU basis."""
    a, e = math.radians(az), math.radians(el)
    return enu.T @ np.array([math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)])


@pytest.mark.parametrize("lat,lon", [(0, 0), (-89.5, 223), (45, 270), (-90, 0), (-90, 123), (90, 40), (0, 359.9)])
def test_enu_orthonormal_right_handed(lat, lon):
    b = enu_basis(lat, lon)
    assert np.allclose(b @ b.T, np.eye(3), atol=1e-14)
    assert np.allclose(np.cross(b[0], b[1]), b[2], atol=1e-14)  # east x north = up


def test_enu_axes_at_lon0_lat0():
    e, n, u = enu_basis(0, 0)
    assert np.allclose(u, [1, 0, 0]) and np.allclose(e, [0, 1, 0]) and np.allclose(n, [0, 0, 1])
    e, n, u = enu_basis(0, 90)  # east-positive longitude: +90E is +y
    assert np.allclose(u, [0, 1, 0]) and np.allclose(e, [-1, 0, 0])


def test_observer_position_radius_and_height():
    assert np.linalg.norm(observer_position_km(-89.5, 223, 0)) == pytest.approx(1737.4)
    assert np.linalg.norm(observer_position_km(10, 20, 1500)) == pytest.approx(1738.9)
    assert observer_position_km(-90, 77, 0) == pytest.approx([0, 0, -1737.4], abs=1e-9)


def test_equatorial_site_sees_earth_overhead_sun_matches_geometry():
    r = calculate_positions(0, 0, 0, T)  # sub-Earth point of the Mean Earth frame
    assert r["earth"]["elevation_deg"] > 75  # libration <~ 10 deg
    et = sp.str2et("2027-03-14T12:00:00")
    sun_c, _ = sp.spkpos("SUN", et, MOON_FRAME, "LT+S", "MOON")
    # Parallax from the lunar radius is < 1737.4/1.49e8 rad = 0.0007 deg.
    assert abs(r["sun"]["distance_km"] - np.linalg.norm(sun_c)) < 1737.4
    # Sun elevation from the centre-based direction must agree to the parallax level.
    el_c = math.degrees(math.asin(enu_basis(0, 0)[2] @ sun_c / np.linalg.norm(sun_c)))
    assert abs(r["sun"]["elevation_deg"] - el_c) < 0.001


def test_south_polar_site_geometry():
    r = calculate_positions(-89.5, 223.0, 0.0, T)
    assert abs(r["sun"]["elevation_deg"]) < 2.0     # solar declination < 1.55 deg + offset
    assert abs(r["earth"]["elevation_deg"]) < 10.0  # latitude libration
    assert 0.26 < r["sun"]["angular_radius_deg"] < 0.28
    assert 0.85 < r["earth"]["angular_radius_deg"] < 1.10
    assert 356_000 < r["earth"]["distance_km"] < 407_000
    assert 1.47e8 < r["sun"]["distance_km"] < 1.53e8


def test_pinned_values_match_recorded_horizons():
    # Recorded from JPL Horizons (CENTER coord@301, CYLINDRICAL site, APPARENT=AIRLESS) on 2026-11-14.
    r = calculate_positions(-89.5, 223.0, 0.0, T)
    assert r["sun"]["azimuth_deg"] == pytest.approx(237.849546, abs=1e-5)
    assert r["sun"]["elevation_deg"] == pytest.approx(-1.105002, abs=1e-5)
    assert r["earth"]["azimuth_deg"] == pytest.approx(132.732034, abs=1e-5)
    assert r["earth"]["elevation_deg"] == pytest.approx(5.782464, abs=1e-5)
    assert r["earth"]["distance_km"] == pytest.approx(374496.708, abs=0.05)


@pytest.mark.parametrize("lat,lon,h,t", [
    (0, 0, 0, T), (-89.5, 223, 0, T), (-90, 0, 0, T), (90, 10, 500, T),
    (35.2, -140.3, 1234.5, "2030-07-01T23:59:59.5Z"), (-60, 359.99, -2000, "2026-12-31T00:00:00+00:00"),
])
def test_ranges_finite_and_json(lat, lon, h, t):
    r = json.loads(json.dumps(calculate_positions(lat, lon, h, t)))
    for body in ("sun", "earth"):
        d = r[body]
        assert all(math.isfinite(v) for v in d.values())
        assert 0 <= d["azimuth_deg"] < 360
        assert -90 <= d["elevation_deg"] <= 90
        assert d["distance_km"] > 0 and 0 < d["angular_radius_deg"] < 2
    m = r["model"]
    assert (m["reference_frame"], m["reference_radius_km"], m["aberration_correction"]) == (
        "MOON_ME_DE440_ME421", 1737.4, "LT+S")
    assert m["terrain_occlusion_modelled"] is False and m["validation_status"] == "pending"


def test_longitude_wrap_equivalence():
    a, b = calculate_positions(-30, 223, 0, T), calculate_positions(-30, -137, 0, T)
    assert a["sun"]["azimuth_deg"] == pytest.approx(b["sun"]["azimuth_deg"], abs=1e-9)
    assert a["earth"]["elevation_deg"] == pytest.approx(b["earth"]["elevation_deg"], abs=1e-9)


@pytest.mark.parametrize("lat", [-90.0, 90.0])
def test_pole_convention_physical_direction_independent_of_longitude(lat):
    """At an exact pole the azimuth depends on the supplied longitude, but the physical
    direction (and elevation) must not."""
    ref = None
    for lon in (0.0, 123.0, 250.0):
        r = calculate_positions(lat, lon, 0, T)
        v = direction(r["sun"]["azimuth_deg"], r["sun"]["elevation_deg"], enu_basis(lat, lon))
        if ref is None:
            ref, el0 = v, r["sun"]["elevation_deg"]
        assert np.allclose(v, ref, atol=1e-9)
        assert r["sun"]["elevation_deg"] == pytest.approx(el0, abs=1e-9)


@pytest.mark.parametrize("args", [
    (91, 0, 0, T), (-90.0001, 0, 0, T), (0, 361, 0, T), (0, 0, 50000, T), (0, 0, -20000, T),
    (float("nan"), 0, 0, T), (0, float("inf"), 0, T), (True, 0, 0, T), ("1", 0, 0, T),
    (0, 0, 0, "not-a-date"), (0, 0, 0, "2027-03-14T12:00:00"),  # naive: ambiguous, rejected
    (0, 0, 0, "2027-03-14T12:00:00+05:00"), (0, 0, 0, 20270314), (0, 0, 0, "1700-01-01T00:00:00Z"),
    (0, 0, 0, "2400-01-01T00:00:00Z"),
])
def test_invalid_inputs_rejected(args):
    with pytest.raises(ValueError):
        calculate_positions(*args)


def test_cli_json_and_error_codes(capsys):
    assert main(["-89.5", "223.0", "0", T]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["site"]["latitude_deg"] == -89.5 and "sun" in out and "earth" in out
    assert main(["95", "0", "0", T]) == 2
    assert "latitude_deg" in capsys.readouterr().err

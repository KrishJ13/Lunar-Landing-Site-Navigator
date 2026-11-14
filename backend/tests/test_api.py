"""API tests using synthetic maps (no downloads needed)."""

import numpy as np
import pytest
from fastapi.testclient import TestClient

from lunar.api.app import create_app
from lunar.config import MOON_RADIUS_M as R
from lunar.dem import DemProduct


@pytest.fixture
def client(make_cylindrical, make_polar):
    background = DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat))
    plateau = DemProduct.open(make_polar(lambda x, y: np.where(x > 20_000, 1.0, 0.0), n=201, scale_m=500.0))
    return TestClient(create_app(products=[background, plateau]))


def test_health_lists_maps(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert [m["pixel_size_m"] for m in body["maps_loaded"]] == [500.0, pytest.approx(7581.3, rel=1e-3)]


def test_health_without_maps():
    body = TestClient(create_app(products=[])).get("/api/health").json()
    assert body["status"] == "no elevation maps loaded"


def test_horizon_response_shape(client):
    r = client.post("/api/horizon", json={"lat": -90, "lon": 0, "observer_heights_m": [2, 10], "azimuth_step_deg": 5})
    assert r.status_code == 200
    body = r.json()
    assert body["site"]["map"]["pixel_size_m"] == 500.0
    assert body["settings"]["min_step_m"] == 250.0
    assert [s["observer_height_m"] for s in body["skylines"]] == [2, 10]
    for s in body["skylines"]:
        n = len(s["azimuth_deg"])
        assert n == 72
        for key in ("elevation_deg", "distance_km", "terrain_m", "skyline_lat", "skyline_lon",
                    "map_pixel_size_m", "at_max_range"):
            assert len(s[key]) == n, key
    assert body["meta"]["model_version"] == "horizon-v1"


def test_horizon_values_on_synthetic_terrain(client):
    body = client.post("/api/horizon", json={"lat": -90, "lon": 0, "azimuth_step_deg": 10}).json()
    sky = body["skylines"][0]
    by_az = dict(zip(sky["azimuth_deg"], sky["elevation_deg"]))
    assert by_az[90.0] > 2.0  # the plateau wall
    expected_dip = -np.degrees(np.arccos(R / (R + 2)))
    assert sky["smooth_horizon_dip_deg"] == pytest.approx(expected_dip, abs=1e-5)
    assert by_az[270.0] == pytest.approx(expected_dip, abs=0.01)


def test_longitude_is_normalised(client):
    a = client.post("/api/horizon", json={"lat": -89.9, "lon": -90, "azimuth_step_deg": 10}).json()
    b = client.post("/api/horizon", json={"lat": -89.9, "lon": 270, "azimuth_step_deg": 10}).json()
    assert a["site"]["lon"] == 270.0
    assert a["skylines"] == b["skylines"]


@pytest.mark.parametrize(
    "payload",
    [
        {"lat": 91, "lon": 0},
        {"lat": 0, "lon": 0, "observer_heights_m": []},
        {"lat": 0, "lon": 0, "observer_heights_m": [-1]},
        {"lat": 0, "lon": 0, "observer_heights_m": [1, 2, 3, 4, 5, 6]},
        {"lat": 0, "lon": 0, "azimuth_step_deg": 0.01},
        {"lat": 0, "lon": 0, "max_range_km": 10_000},
        {"lon": 0},
    ],
)
def test_invalid_requests_are_rejected(client, payload):
    assert client.post("/api/horizon", json=payload).status_code == 422


def test_no_maps_gives_503():
    r = TestClient(create_app(products=[])).post("/api/horizon", json={"lat": 0, "lon": 0})
    assert r.status_code == 503


def test_cors_allows_vite_dev_server(client):
    r = client.options(
        "/api/horizon",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"},
    )
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"


class TestView:
    def test_view_shape_and_defaults(self, client):
        r = client.post("/api/view", json={"lat": -90, "lon": 0, "azimuth_step_deg": 10})
        assert r.status_code == 200
        body = r.json()
        assert body["skyline"]["observer_height_m"] == 1.8
        land = body["landscape"]
        assert len(land["azimuth_deg"]) == len(land["segments"]) == 36
        assert land["segment_fields"][0] == "el_low_deg" and land["segment_fields"][-1] == "height_m"
        assert len(land["mean_level_elevation_deg"]) == 36
        info = body["site_info"]
        assert info["ground_m"] == 0 and info["eye_m"] == 1.8
        assert info["setting"].startswith("open")
        assert [s["radius_m"] for s in info["surroundings"]] == [1000, 10000]
        for strip, top in zip(land["segments"], body["skyline"]["elevation_deg"]):
            assert strip[0][0] == -90
            assert strip[-1][1] == pytest.approx(top, abs=1e-3)

    def test_smooth_horizon_numbers(self, client):
        body = client.post("/api/view", json={"lat": 0, "lon": 0, "observer_height_m": 1.8, "azimuth_step_deg": 10}).json()
        sh = body["smooth_horizon"]
        assert sh["radius_m"] == 1_737_400
        assert sh["line_of_sight_m"] == pytest.approx(2500.93, abs=0.01)
        assert sh["earth_line_of_sight_m"] == pytest.approx(4789.11, abs=0.01)
        assert sh["dip_deg"] == pytest.approx(0.08248, abs=1e-5)

    @pytest.mark.parametrize("height", [-1, 100.5])
    def test_eye_height_limits(self, client, height):
        r = client.post("/api/view", json={"lat": 0, "lon": 0, "observer_height_m": height})
        assert r.status_code == 422


class TestRidges:
    def test_ridges_shape(self, client):
        r = client.post("/api/ridges", json={"lat": -90, "lon": 0, "azimuth_step_deg": 2})
        assert r.status_code == 200
        body = r.json()
        assert len(body["skyline"]["azimuth_deg"]) == 180
        assert body["ridgelines"], "expected at least one ridgeline"
        d = [line["median_distance_km"] for line in body["ridgelines"]]
        assert d == sorted(d, reverse=True)  # far to near
        for line in body["ridgelines"]:
            n = len(line["azimuth_deg"])
            assert all(len(line[k]) == n for k in ("elevation_deg", "distance_km", "height_m", "lat", "lon", "skyline"))
        assert body["peaks"] and body["peaks"][0]["on_skyline"]

    def test_plateau_wall_is_a_ridgeline_east(self, client):
        body = client.post("/api/ridges", json={"lat": -90, "lon": 0, "azimuth_step_deg": 2}).json()
        walls = [ln for ln in body["ridgelines"] if 19 <= ln["median_distance_km"] <= 40]
        assert walls, "the 1 km plateau 20 km east should appear as a ridgeline"
        az = [a % 360 for a in walls[0]["azimuth_deg"]]
        assert min(az) < 90 < max(az)

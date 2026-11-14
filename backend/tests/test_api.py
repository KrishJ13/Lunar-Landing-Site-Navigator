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

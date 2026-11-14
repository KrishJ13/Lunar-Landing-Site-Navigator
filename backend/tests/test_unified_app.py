"""Unified service: both route families on one app, contracts preserved, subsystems fail independently."""
import numpy as np
import pytest
from fastapi.testclient import TestClient

from lunar.dem import DemProduct
from lunar_sky import api as sky
from lunar_skyline.app import create_app


@pytest.fixture
def products(make_cylindrical):
    return [DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat + 0.5))]  # 500 m everywhere


def test_both_route_families(products):
    with TestClient(create_app(products)) as c:
        paths = set(c.get("/openapi.json").json()["paths"])
        assert {"/api/health", "/api/horizon", "/api/view", "/api/ridges",
                "/api/v1/health", "/api/v1/positions", "/api/v1/positions/series"} <= paths
        assert c.get("/api/health").json()["status"] == "ok"
        assert c.get("/api/v1/health").json()["kernels_ready"] is True


def test_error_formats_stay_per_family(products):
    with TestClient(create_app(products)) as c:
        r = c.get("/api/v1/positions?lat=95&lon=0&timestamp_utc=2027-03-14T12:00:00Z")
        assert r.status_code == 422 and r.json()["error"] == "validation_error"
        r = c.post("/api/horizon", json={"lat": 95, "lon": 0})
        assert r.status_code == 422 and isinstance(r.json()["detail"], list)


def test_cors_get_and_post(products):
    with TestClient(create_app(products)) as c:
        h = {"Origin": "http://localhost:5173"}
        assert c.get("/api/v1/health", headers=h).headers["access-control-allow-origin"] == h["Origin"]
        r = c.options("/api/view", headers={**h, "Access-Control-Request-Method": "POST"})
        assert r.headers["access-control-allow-origin"] == h["Origin"]


def test_missing_kernels_keep_terrain_alive(products, restore_spice_state, monkeypatch, tmp_path):
    monkeypatch.setattr(sky, "KDIR", tmp_path)
    with TestClient(create_app(products)) as c:
        assert c.get("/api/v1/health").json()["status"] == "degraded"
        r = c.get("/api/v1/positions?lat=0&lon=0&timestamp_utc=2027-03-14T12:00:00Z")
        assert r.status_code == 503
        assert c.post("/api/view", json={"lat": 0, "lon": 0, "azimuth_step_deg": 10}).status_code == 200


def test_missing_dem_keeps_sky_alive():
    with TestClient(create_app([])) as c:
        assert c.get("/api/health").json()["status"] == "no elevation maps loaded"
        assert c.post("/api/view", json={"lat": 0, "lon": 0}).status_code == 503
        r = c.get("/api/v1/positions?lat=0&lon=0&timestamp_utc=2027-03-14T12:00:00Z")
        assert r.status_code == 200 and "sun" in r.json()


@pytest.mark.parametrize("lat,lon", [(-89.5, 223.0), (0, 0), (45, -137), (-90, 0), (-90, 120), (90, 33)])
def test_engines_share_enu_frame_and_radius(lat, lon):
    """Terrain azimuth/elevation and SPICE azimuth/elevation must use the same East/North/Up."""
    from lunar.config import MOON_RADIUS_M
    from lunar.geometry import enu_basis as terrain_enu
    from lunar_sky import positions

    e, n, u = (np.asarray(v, float).reshape(3) for v in terrain_enu(lat, lon))
    assert np.allclose(np.vstack([e, n, u]), positions.enu_basis(lat, lon), atol=1e-12)
    assert MOON_RADIUS_M / 1000 == positions.REFERENCE_RADIUS_KM

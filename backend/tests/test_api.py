import math

import pytest
from fastapi.testclient import TestClient

from lunar_sky import api
from lunar_sky.positions import calculate_positions

Q = "lat=-89.5&lon=223&elevation_m=0&timestamp_utc=2027-03-14T12:00:00Z"
T = "timestamp_utc=2027-03-14T12:00:00Z"


@pytest.fixture(scope="module")
def client():
    with TestClient(api.app) as c:
        yield c


def get(c, q):
    return c.get(f"/api/v1/positions?{q}")


def test_health_ok(client):
    r = client.get("/api/v1/health")
    assert r.status_code == 200 and r.json()["status"] == "ok" and r.json()["kernels_ready"] is True


def test_positions_match_function(client):
    r = get(client, Q)
    assert r.status_code == 200
    exp = calculate_positions(-89.5, 223.0, 0.0, "2027-03-14T12:00:00Z")
    got = r.json()
    for b in ("sun", "earth"):
        for k, v in exp[b].items():
            assert math.isclose(got[b][k], v, rel_tol=1e-12, abs_tol=1e-12)
    assert got["site"] == exp["site"] and got["model"] == exp["model"]
    assert got["timestamp_utc"] == exp["timestamp_utc"]


def test_default_elevation(client):
    assert get(client, f"lat=0&lon=0&{T}").json()["site"]["elevation_m"] == 0


@pytest.mark.parametrize("lat", ["91", "-90.1", "abc", "nan", "inf"])
def test_bad_lat(client, lat):
    assert get(client, f"lat={lat}&lon=0&{T}").status_code == 422


def test_lon_normalisation(client):
    a = get(client, f"lat=10&lon=-137&{T}").json()
    b = get(client, f"lat=10&lon=223&{T}").json()
    assert a["sun"] == b["sun"] and a["earth"] == b["earth"]
    assert get(client, f"lat=10&lon=361&{T}").status_code == 422
    assert get(client, f"lat=10&lon=nan&{T}").status_code == 422


@pytest.mark.parametrize("q", [
    "lat=0&lon=0",
    "lat=0&lon=0&timestamp_utc=garbage",
    "lat=0&lon=0&timestamp_utc=2027-03-14T12:00:00",
    "lat=0&lon=0&timestamp_utc=2027-03-14T12:00:00%2B05:00",
    f"lat=0&lon=0&elevation_m=nan&{T}",
    f"lat=0&lon=0&elevation_m=1e9&{T}",
])
def test_bad_inputs(client, q):
    r = get(client, q)
    assert r.status_code == 422 and r.json()["error"] == "validation_error"


def test_out_of_coverage(client):
    r = get(client, "lat=0&lon=0&timestamp_utc=1500-01-01T00:00:00Z")
    assert r.status_code == 400 and r.json()["error"] == "ephemeris_unavailable"
    assert "Traceback" not in r.text


def test_missing_kernels(monkeypatch):
    def boom():
        raise RuntimeError("nope")

    monkeypatch.setattr(api, "load_kernels", boom)
    with TestClient(api.app) as c:
        h = c.get("/api/v1/health").json()
        assert h["status"] == "degraded" and h["kernels_ready"] is False
        r = get(c, Q)
        assert r.status_code == 503 and "sun" not in r.json()


def test_missing_files(monkeypatch, tmp_path):
    monkeypatch.setattr(api, "KDIR", tmp_path)
    with TestClient(api.app) as c:
        assert c.get("/api/v1/health").json()["kernels_ready"] is False
        assert get(c, Q).status_code == 503


def test_openapi(client):
    spec = client.get("/openapi.json").json()
    op = spec["paths"]["/api/v1/positions"]["get"]
    assert {"200", "400", "422", "503"} <= set(op["responses"])
    assert "/api/v1/health" in spec["paths"] and client.get("/docs").status_code == 200


def test_cors(client):
    r = client.get("/api/v1/health", headers={"Origin": "http://localhost:5173"})
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"
    r = client.get("/api/v1/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in r.headers

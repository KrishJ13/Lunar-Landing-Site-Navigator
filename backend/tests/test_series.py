import math
import threading
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from lunar_sky import api, positions

BASE = "lat=-89.5&lon=223&elevation_m=0&start_utc=2027-03-14T00:00:00Z"
URL = "/api/v1/positions/series"


@pytest.fixture(scope="module")
def client():
    with TestClient(api.app) as c:
        yield c


def series(c, hours, step, base=BASE):
    return c.get(f"{URL}?{base}&hours={hours}&step_minutes={step}")


def ts(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def test_one_hour(client):
    j = series(client, 1, 10).json()
    assert j["sample_count"] == 7 == len(j["samples"])
    assert j["end_included"] and j["end_utc"] == "2027-03-14T01:00:00Z" == j["last_sample_utc"]
    assert j["model"]["terrain_occlusion_modelled"] is False


def test_seven_days_increments_finite_ascending(client):
    r = series(client, 168, 60)
    assert r.status_code == 200
    j = r.json()
    assert j["sample_count"] == 169 and j["end_utc"] == "2027-03-21T00:00:00Z" and j["end_included"]
    t = [ts(s["timestamp_utc"]) for s in j["samples"]]
    assert t[0] == ts("2027-03-14T00:00:00Z") and t[-1] == ts(j["end_utc"])
    assert all(b - a == timedelta(minutes=60) for a, b in zip(t, t[1:]))
    for s in j["samples"]:
        assert all(math.isfinite(v) for b in ("sun", "earth") for v in s[b].values())


def test_unaligned_end_excluded(client):
    j = series(client, 1, 25).json()  # 60/25 = 2.4 -> samples at 0, 25, 50
    assert j["sample_count"] == 3 and not j["end_included"]
    assert j["end_utc"] == "2027-03-14T01:00:00Z" and j["last_sample_utc"] == "2027-03-14T00:50:00Z"


def test_fractional_hours(client):
    assert series(client, 0.5, 10).json()["sample_count"] == 4


@pytest.mark.parametrize("hours,step", [(0, 60), (-1, 60), (169, 60), ("nan", 60), (1, 9), (1, 361), (1, "inf")])
def test_bad_span(client, hours, step):
    r = series(client, hours, step)
    assert r.status_code == 422 and r.json()["error"] == "validation_error"


def test_excessive_samples(client):
    r = series(client, 168, 10)  # 1009 samples
    assert r.status_code == 422 and "1009" in r.json()["detail"]
    assert series(client, 166, 10).json()["sample_count"] == 997  # under the cap
    assert series(client, 166.5, 10).json()["sample_count"] == 1000  # exactly at the cap
    assert series(client, 166.7, 10).status_code == 422


@pytest.mark.parametrize("start", ["garbage", "2027-03-14T00:00:00", "2027-03-14T00:00:00%2B05:00", ""])
def test_invalid_utc(client, start):
    r = series(client, 1, 10, f"lat=0&lon=0&start_utc={start}")
    assert r.status_code == 422 and r.json()["error"] == "validation_error"


def test_missing_start(client):
    assert client.get(f"{URL}?lat=0&lon=0&hours=1&step_minutes=10").status_code == 422


@pytest.mark.parametrize("start,hours", [("1500-01-01T00:00:00Z", 1), ("2150-01-20T00:00:00Z", 168),
                                         ("2200-01-01T00:00:00Z", 1)])
def test_out_of_coverage(client, start, hours):
    r = series(client, hours, 60, f"lat=0&lon=0&start_utc={start}")
    assert r.status_code == 400 and r.json()["error"] == "ephemeris_unavailable"
    assert "Traceback" not in r.text and "samples" not in r.json()


def test_failure_mid_series_is_error_not_partial(client, monkeypatch):
    real = positions._evaluate
    n = {"c": 0}

    def flaky(*a):
        n["c"] += 1
        if n["c"] == 30:
            raise positions.sp.SpiceyError("boom")
        return real(*a)

    monkeypatch.setattr(positions, "_evaluate", flaky)
    r = series(client, 24, 10)
    assert r.status_code == 400 and "samples" not in r.json()


def test_equivalence_with_positions(client):
    j = series(client, 6, 60, "lat=12.5&lon=-137&elevation_m=250&start_utc=2027-03-14T00:00:00Z").json()
    for s in j["samples"]:
        p = client.get("/api/v1/positions?lat=12.5&lon=-137&elevation_m=250&timestamp_utc=" + s["timestamp_utc"]).json()
        for b in ("sun", "earth"):
            assert s[b] == p[b]  # bit-identical
    assert j["model"] == p["model"]


def test_pole_equivalence(client):
    j = series(client, 1, 30, "lat=-90&lon=0&start_utc=2027-03-14T00:00:00Z").json()
    p = client.get("/api/v1/positions?lat=-90&lon=0&timestamp_utc=2027-03-14T00:30:00Z").json()
    assert j["samples"][1]["sun"] == p["sun"]


def test_concurrent_requests_serialised(client, monkeypatch):
    inside, peak, order = [0], [0], []
    guard = threading.Lock()
    real = positions.evaluate_series_chunk

    def spy(*a):
        with guard:
            inside[0] += 1
            peak[0] = max(peak[0], inside[0])
        try:
            return real(*a)
        finally:
            with guard:
                inside[0] -= 1

    monkeypatch.setattr(positions, "evaluate_series_chunk", spy)
    monkeypatch.setattr(api, "SERIES_CHUNK", 10)
    base = series(client, 24, 10).json()
    results = []

    def work():
        results.append(series(client, 24, 10).json())

    th = [threading.Thread(target=work) for _ in range(6)]
    [t.start() for t in th]
    [t.join() for t in th]
    assert len(results) == 6 and all(r["samples"] == base["samples"] for r in results)
    assert peak[0] == 1  # SPICE work never overlapped


def test_openapi(client):
    op = client.get("/openapi.json").json()["paths"][URL]["get"]
    assert {"200", "400", "422", "503"} <= set(op["responses"])
    assert "terrain" in op["description"]


def test_missing_kernels(restore_spice_state, monkeypatch):
    monkeypatch.setattr(api, "load_kernels", lambda: (_ for _ in ()).throw(RuntimeError("nope")))
    with TestClient(api.app) as c:
        r = series(c, 1, 10)
        assert r.status_code == 503 and "samples" not in r.json()

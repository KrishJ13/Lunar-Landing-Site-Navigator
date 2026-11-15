import numpy as np
import pytest
from fastapi.testclient import TestClient

from lunar_sky.site_windows import find_windows, next_crossings
from lunar_skyline.app import create_app


@pytest.mark.parametrize("value, expected", [(1.0, 370.0), (-1.0, 0.0)])
def test_constant_visibility_uses_exact_range(value, expected):
    times = np.array([0, 120, 240, 360, 370])
    result = find_windows(times, np.full(times.size, value), lambda _: value)
    assert not result["events"]
    assert result["visible_duration_s"] == expected


def test_crossings_are_refined_and_period_boundaries_are_clipped():
    def margin(time):
        return (time - 30) * (time - 140)

    times = np.array([0, 120, 180])
    result = find_windows(times, margin(times), margin)
    assert [event["kind"] for event in result["events"]] == ["set", "rise"]
    assert [event["at_s"] for event in result["events"]] == pytest.approx([30, 140], abs=1)
    assert result["windows"][0]["start_s"] == 0
    assert result["windows"][-1]["end_s"] == 180
    assert result["visible_duration_s"] == pytest.approx(70, abs=1)


def test_next_crossings_carries_state_between_batches():
    def evaluate(times):
        values = np.asarray(times)
        return np.stack((13 - values, values - 531))

    result = next_crossings(10, 600, 1, evaluate([10])[:, 0], evaluate)
    assert result["sun"]["kind"] == "set"
    assert result["sun"]["at_s"] == pytest.approx(13, abs=1)
    assert result["earth"]["kind"] == "rise"
    assert result["earth"]["at_s"] == pytest.approx(531, abs=1)


def test_windows_api_uses_ephemeris_and_respects_terrain():
    params = dict(lat=0, lon=0, observer_elevation_m=2, start_utc="2027-03-14T12:00:00Z",
                  hours=24 * 30, skyline_deg=[0] * 360)
    with TestClient(create_app([])) as client:
        response = client.post("/api/site/windows", json=params)
        assert response.status_code == 200, response.text
        result = response.json()
        assert {event["kind"] for event in result["sun"]["events"]} == {"rise", "set"}
        assert result["sun"]["visible_duration_s"] == pytest.approx(14.8 * 86400, rel=0.13)
        window, = result["earth"]["windows"]
        assert window["start_s"] == 0
        assert window["end_s"] == params["hours"] * 3600
        direction = window["opening_direction"]
        assert 0 <= direction["azimuth_deg"] < 360
        assert direction["clearance_deg"] == pytest.approx(direction["elevation_deg"])
        assert direction["clearance_deg"] > 0
        params.update(hours=1.01, skyline_deg=[90] * 360)
        response = client.post("/api/site/windows", json=params)
        assert response.status_code == 200, response.text
        assert response.json()["duration_s"] == pytest.approx(3636)
        assert response.json()["sun"]["windows"] == response.json()["earth"]["windows"] == []


def test_next_event_after_mission_does_not_change_mission_totals():
    params = dict(lat=0, lon=0, observer_elevation_m=2, start_utc="2027-03-14T12:00:00Z",
                  hours=1, skyline_deg=[0] * 360)
    with TestClient(create_app([])) as client:
        baseline = client.post("/api/site/windows", json=params)
        assert baseline.status_code == 200, baseline.text
        response = client.post("/api/site/windows", json={**params, "include_next_event": True})
        assert response.status_code == 200, response.text
        result = response.json()
        forecast = result.pop("after_mission")
        assert result == baseline.json()
        assert result["duration_s"] < forecast["events"]["sun"]["at_s"] <= forecast["searched_until_s"]
        assert "earth" not in forecast["events"]

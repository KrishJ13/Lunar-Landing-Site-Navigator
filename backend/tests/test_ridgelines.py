"""Ridgeline linking and peak tests on synthetic terrain."""

import numpy as np
import pytest

from lunar.dem import DemProduct
from lunar.ridgelines import find_peaks, link_ridgelines
from lunar.ridges import CrestView, compute_crests


def ridges(x, y):
    """Two straight ridges running along map-y, east of the south pole:
    near ridge 300 m high at x = 10 km, far mountain ridge 3 km high at 40 km."""
    return 0.3 * np.exp(-(((x - 10_000) / 1_500) ** 2)) + 3.0 * np.exp(-(((x - 40_000) / 4_000) ** 2))


@pytest.fixture
def view(make_cylindrical, make_polar):
    products = [
        DemProduct.open(make_cylindrical(lambda lat, lon: 0 * lat)),
        DemProduct.open(make_polar(ridges, n=241, scale_m=500.0)),
    ]
    return compute_crests(products, -90, 0, 2.0, azimuth_step_deg=1.0, min_step_m=250)


def by_distance(lines, lo_km, hi_km):
    return [r for r in lines if lo_km * 1000 <= r.median_distance_m <= hi_km * 1000]


class TestLinking:
    def test_each_straight_ridge_is_one_continuous_line(self, view):
        lines = link_ridgelines(view)
        near = by_distance(lines, 9, 16)
        far = by_distance(lines, 35, 70)
        assert len(near) == 1 and len(far) == 1
        # Seen from the pole, the near ridge spans a wide arc centred due east (az 90).
        assert near[0].span_deg > 100
        assert near[0].azimuth_deg[0] < 90 < near[0].azimuth_deg[-1]
        # No gaps: consecutive points are one direction apart (or a bridged gap of <= 3).
        assert np.diff(near[0].azimuth_deg).max() <= 3.0

    def test_straight_ridge_distance_follows_geometry(self, view):
        near = by_distance(link_ridgelines(view), 9, 16)[0]
        az = np.array(near.azimuth_deg)
        d = np.array(near.distance_m)
        mid = np.abs(az - 90) <= 30
        # A straight ridge 10 km east is 10 km / cos(az - 90) away along each direction.
        np.testing.assert_allclose(d[mid], 10_000 / np.cos(np.radians(az[mid] - 90)), rtol=0.05)

    def test_plain_horizon_is_one_ring_across_north(self, view):
        lines = link_ridgelines(view)
        ring = by_distance(lines, 2, 3.5)
        assert len(ring) == 1
        assert ring[0].span_deg >= 355  # all the way round, joined across due north

    def test_sorted_far_to_near(self, view):
        d = [r.median_distance_m for r in link_ridgelines(view)]
        assert d == sorted(d, reverse=True)


    def test_every_crest_is_in_some_ridgeline(self, view):
        # Painter's algorithm needs every visible crest, including short fragments.
        lines = link_ridgelines(view)
        assert sum(len(r.azimuth_deg) for r in lines) == sum(len(c) for c in view.crests)


class TestPeaks:
    def test_far_mountain_is_the_top_peak(self, view):
        lines = link_ridgelines(view)
        peaks = find_peaks(lines)
        top = peaks[0]
        assert top.on_skyline
        assert top.azimuth_deg == pytest.approx(90, abs=2)
        assert top.distance_m == pytest.approx(40_000, rel=0.05)
        assert top.height_m == pytest.approx(3_000, rel=0.05)

    def test_nearby_ground_edges_are_not_peaks(self, view):
        # The plain's own horizon (~2.6 km) is a ridgeline but, with a 5 km
        # cut-off, must not be listed as a peak.
        peaks = find_peaks(link_ridgelines(view), min_distance_m=5_000)
        assert all(p.distance_m >= 5_000 for p in peaks)

    def test_peaks_are_spread_out(self, view):
        peaks = find_peaks(link_ridgelines(view), min_separation_deg=10)
        az = sorted(p.azimuth_deg for p in peaks)
        gaps = np.diff(az + [az[0] + 360])
        assert gaps.min() >= 10 - 1e-9


def test_merge_across_north():
    # Hand-made crests: one ridge at 5 km from 350 deg through north to 10 deg.
    az = np.arange(0.0, 360.0, 1.0)
    crests = []
    for a in az:
        inside = a >= 350 or a <= 10
        crests.append(np.array([[5_000.0, 1.0, 100.0, -89.0, a, 1.0]]) if inside else np.zeros((0, 6)))
    view = CrestView(observer=None, azimuth_deg=az, crests=crests, max_range_m=300_000)
    lines = link_ridgelines(view)
    assert len(lines) == 1
    assert lines[0].azimuth_deg[0] == 350 and lines[0].azimuth_deg[-1] == 370

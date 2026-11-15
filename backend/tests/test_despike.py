"""Spike correction (lunar.despike)."""

import numpy as np

from lunar.despike import despike


def _grid(n=81, spacing=10.0):
    x = (np.arange(n) - n // 2) * spacing
    return np.meshgrid(x, x)


def test_isolated_spike_and_pit_are_removed():
    x, y = _grid()
    h = 0.05 * x + 0.02 * y  # a gentle slope
    bad = h.copy()
    bad[40, 40] += 130.0  # +130 m spike, one source cell
    bad[20, 60] -= 90.0  # -90 m pit
    fixed, n = despike(bad, spacing_m=10.0, cell_m=10.0)
    assert n == 2
    np.testing.assert_allclose(fixed, h, atol=0.5)


def test_resampled_spike_is_removed_but_nothing_else():
    # A 20 m source map resampled at 5 m: the spike spreads over the neighbouring nodes.
    x, y = _grid(n=161, spacing=5.0)
    h = 30 * np.sin(x / 400) * np.cos(y / 300)
    bad = h.copy()
    bad[78:83, 78:83] += np.outer(np.r_[0.25, 0.5, 1, 0.5, 0.25], np.r_[0.25, 0.5, 1, 0.5, 0.25]) * 150
    fixed, n = despike(bad, spacing_m=5.0, cell_m=20.0)
    assert n > 0 and np.abs(fixed - h).max() < 12.0
    untouched = np.ones(h.shape, bool)
    untouched[74:87, 74:87] = False
    np.testing.assert_array_equal(fixed[untouched], bad[untouched])


def test_real_summits_ridges_and_rims_are_kept():
    x, y = _grid(n=121, spacing=20.0)
    r = np.hypot(x, y)
    cone = np.maximum(0, 600 - 0.6 * r)  # a 600 m peak with 31 deg slopes
    ridge = 400 * np.exp(-(x / 120) ** 2)  # a narrow 400 m ridge
    crater = np.where(r < 500, -200 + 0.0008 * r ** 2, 80 * np.exp(-((r - 520) / 60) ** 2))  # bowl + rim
    for surface in (cone, ridge, crater):
        fixed, n = despike(surface, spacing_m=20.0, cell_m=20.0)
        assert n == 0, n
        np.testing.assert_array_equal(fixed, surface)


def test_nan_stays_nan():
    x, y = _grid()
    h = 0.01 * x
    h[0, :5] = np.nan
    fixed, _ = despike(h, 10.0, 10.0)
    assert np.isnan(fixed[0, :5]).all() and np.isfinite(fixed[1:]).all()

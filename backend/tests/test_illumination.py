"""Horizon maps and illumination over time (lunar.horizon_maps, lunar.illumination)."""

import numpy as np
import pytest

from lunar.config import MOON_RADIUS_M as R
from lunar.dem import DemProduct
from lunar.geometry import enu_basis
from lunar.horizon_maps import build_horizon_maps, direct_horizon, map_surfaces
from lunar.illumination import illumination_series, summarise, visible_fraction


def _maps(products, lat, lon, diameter, **kw):
    near, far = map_surfaces(products, 60.0)
    return near, far, build_horizon_maps(near, far, lat, lon, diameter, points_across=17, **kw)


def test_bare_sphere_horizon_is_the_dip_below_level(make_cylindrical):
    products = [DemProduct.open(make_cylindrical(lambda lat, lon: np.zeros_like(lat), ppd=4))]
    _, _, hm = _maps(products, 10.0, 20.0, 5_000, mast_height_m=2.0)
    dip = np.degrees(np.arccos(R / (R + 2.0)))  # 0.0869 deg for a 2 m mast
    inside = hm.horizon_deg[hm.in_disc]
    # Sampled ground never rises above the tangent ray, and the 1 % steps reach it to < 0.001 deg.
    assert inside.max() <= -dip + 1e-6
    assert inside.min() > -dip - 1e-3


def test_map_matches_direct_rays_over_a_ridge(make_polar):
    def ridge(x, y):  # km: a 2 km high, 6 km wide ridge 15 km from the pole
        return 2.0 * np.exp(-((y - 15e3) ** 2) / (2 * 3e3 ** 2))

    products = [DemProduct.open(make_polar(ridge, n=801, scale_m=100.0))]
    near, far, hm = _maps(products, -89.9, 0.0, 8_000)
    diffs = []
    for i, j in [(8, 8), (3, 10), (12, 5), (8, 15)]:
        ref = direct_horizon(near, far, hm.params["near_reach_m"], hm.point_lat[i, j], hm.point_lon[i, j],
                             hm.mast_height_m, hm.azimuth_deg - hm.gamma_deg[i, j], max_range_m=40_000,
                             min_step_m=hm.params["near_spacing_m"] / 2)
        diffs.append(np.abs(hm.horizon_deg[i, j] - ref))
    diffs = np.concatenate(diffs)
    assert np.median(diffs) < 0.02 and diffs.max() < 0.3
    assert np.nanmax(hm.horizon_deg) > 5  # the ridge is seen


def test_visible_fraction_of_the_disc_is_the_circular_segment():
    # Flat horizon at 0 deg; disc radius r with centre e above it: segment area formula.
    r = 0.27
    flat = np.zeros((1, 360))
    for e in (-0.3, -0.2, -0.1, 0.0, 0.05, 0.13, 0.3):
        t = np.clip(e / r, -1, 1)
        expected = 1 - (np.arccos(t) - t * np.sqrt(1 - t * t)) / np.pi
        got = visible_fraction(flat, 1.0, np.array([123.0]), np.array([e]), np.array([r]))[0]
        assert got == pytest.approx(expected, abs=0.003)


def test_illumination_series_on_the_bare_sphere(make_cylindrical):
    products = [DemProduct.open(make_cylindrical(lambda lat, lon: np.zeros_like(lat), ppd=4))]
    _, _, hm = _maps(products, 10.0, 20.0, 5_000, mast_height_m=2.0)
    east, north, up = enu_basis(10.0, 20.0)
    far_sun = 1.496e11
    radius_m = 6.957e8
    elevations = np.array([5.0, 0.0, -5.0])
    suns = [far_sun * (np.cos(np.radians(e)) * north + np.sin(np.radians(e)) * up) for e in elevations]
    lit, az, el = illumination_series(hm, np.array(suns), radius_m)
    c = len(hm.xy_m) // 2
    np.testing.assert_allclose(el, elevations, atol=0.01)
    assert lit[0, c, c] == pytest.approx(1.0) and lit[2, c, c] == 0.0
    # Sun centre on the eye's level: the dip (0.087 deg) shows a little more than half the disc.
    assert 0.5 < lit[1, c, c] < 0.75
    mean, longest = summarise(lit, hm.in_disc, 1.0)
    assert longest[c, c] == 1.0 and np.isnan(mean[0, 0])


def test_tiles_match_a_direct_block_and_reuse_between_nearby_sites(make_cylindrical, tmp_path):
    from lunar.horizon_maps import compute_block, map_surfaces as surfaces
    from lunar.horizon_tiles import TILE, HorizonTiles, near_radius_for, spacing_for

    def hills(lat, lon):  # km: gentle hills so horizons vary from point to point
        return 0.3 * np.sin(np.radians(lat) * 400) * np.cos(np.radians(lon) * 300)

    products = [DemProduct.open(make_cylindrical(hills, ppd=64))]
    tiles = HorizonTiles(products, tmp_path)
    a = tiles.site(10.0, 20.0, 5_000, 2.0, prefetch=False)
    assert a.stats["computed"] == a.stats["tiles"]
    b = tiles.site(10.01, 20.01, 5_000, 2.0, prefetch=False)  # ~0.4 km away
    assert b.stats["computed"] == 0 and b.stats["reused"] == b.stats["tiles"]
    # A fresh process reads the same tiles from disk.
    c = HorizonTiles(products, tmp_path).site(10.0, 20.0, 5_000, 2.0, prefetch=False)
    assert c.stats["computed"] == 0
    np.testing.assert_allclose(c.horizon_deg[c.in_disc], a.horizon_deg[a.in_disc], atol=0.03)  # float16 on disk

    # Every node equals a block computed directly over the same lattice nodes.
    s = spacing_for(5_000)
    near, far = surfaces(products, s / max(1, int(np.ceil(s / 60.0))))
    i0, j0 = (a.i0 // TILE) * TILE, (a.j0 // TILE) * TILE
    ny, nx = a.horizon_deg.shape[:2]
    block = compute_block(near, far, a.anchor[0], a.anchor[1], i0 * s, j0 * s, a.i0 - i0 + nx + 8,
                          a.j0 - j0 + ny + 8, s, mast_height_m=2.0, sub_step=8, near_radius_m=near_radius_for(s))
    window = block["horizon_deg"][a.j0 - j0:a.j0 - j0 + ny, a.i0 - i0:a.i0 - i0 + nx]
    assert np.isfinite(a.horizon_deg[a.in_disc]).all()  # every disc node comes from a tile
    np.testing.assert_allclose(a.horizon_deg[a.in_disc], window[a.in_disc], atol=1e-4)
    # The site-to-frame map is accurate to centimetres over the disc.
    assert a.affine_residual_m < 0.5


def test_window_matches_the_map_across_the_longitude_seam(make_cylindrical):
    from lunar.dem.window import windowed

    product = DemProduct.open(make_cylindrical(lambda lat, lon: np.sin(np.radians(lon) * 7) + lat / 90, ppd=16))
    lat = np.linspace(20, 30, 400)
    lon = np.mod(np.linspace(-6, 7, 400), 360)  # straddles 0/360
    w = windowed(product, lat, lon)
    assert w is not product and w.data.width < product.shape[1] / 10
    np.testing.assert_array_equal(w.heights_m(lat, lon), product.heights_m(lat, lon))
    far = np.array([60.0]), np.array([180.0])  # outside the window: falls back to the map
    np.testing.assert_array_equal(w.heights_m(*far), product.heights_m(*far))


def test_threaded_illumination_and_far_rays_equal_the_sequential_result(make_cylindrical, monkeypatch):
    """The speed-ups (thread pools over time chunks and over far-ray nodes) change no value."""
    from lunar import illumination
    from lunar.horizon_maps import compute_block

    def hills(lat, lon):
        return 0.3 * np.sin(np.radians(lat) * 400) * np.cos(np.radians(lon) * 300)

    products = [DemProduct.open(make_cylindrical(hills, ppd=64))]
    near, far = map_surfaces(products, 60.0)
    block = lambda workers: compute_block(near, far, 10.0, 20.0, -2_000.0, -2_000.0, 17, 17, 250.0,
                                          max_range_m=60_000.0, sub_step=4, far_workers=workers)
    np.testing.assert_array_equal(block(1)["horizon_deg"], block(4)["horizon_deg"])

    _, _, hm = _maps(products, 10.0, 20.0, 5_000, mast_height_m=2.0)
    east, north, up = enu_basis(10.0, 20.0)
    angles = np.radians(np.linspace(-4.0, 6.0, 40))
    suns = np.array([1.496e11 * (np.cos(a) * north + np.sin(a) * up) for a in angles])
    monkeypatch.setattr(illumination, "CHUNK_ELEMENTS", 300)  # several chunks, so the pool really runs
    monkeypatch.setattr(illumination, "WORKERS", 1)
    sequential, *_ = illumination_series(hm, suns, 6.957e8)
    monkeypatch.setattr(illumination, "WORKERS", 4)
    threaded, *_ = illumination_series(hm, suns, 6.957e8)
    np.testing.assert_array_equal(sequential, threaded)
    assert 0.0 < sequential[hm.in_disc[None].repeat(len(suns), 0)].mean() < 1.0  # partial lighting was exercised

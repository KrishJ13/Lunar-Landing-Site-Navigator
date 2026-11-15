"""Site terrain package (lunar.terrain, POST /api/site/terrain) on synthetic maps."""

from dataclasses import replace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from lunar.api import terrain_payload
from lunar.api.app import create_app
from lunar.config import MOON_RADIUS_M as R
from lunar.dem import DemProduct
from lunar.foreground import correct_outliers
from lunar.geometry import destination
from lunar.lola_chain import LolaChain
from lunar.panorama import _correct_isolated_peaks, _foreground_normals, _normals, _visible_shade
from lunar.skyline import compute_skyline
from lunar.terrain import build_site_terrain, far_mesh_skyline, ring_distances, site_grid_xy


@pytest.fixture
def flat_moon(make_cylindrical):
    return [DemProduct.open(make_cylindrical(lambda lat, lon: np.zeros_like(lat), ppd=4))]


def _expected_enu(az_deg, d_m, eye_m):
    """A point on the bare sphere at surface distance d, seen from an eye eye_m above it:
    horizontal R sin(d/R) along the azimuth, vertical R cos(d/R) - (R + eye)."""
    a, theta = np.broadcast_arrays(np.radians(az_deg), np.asarray(d_m) / R)
    horiz = R * np.sin(theta)
    return np.stack([horiz * np.sin(a), horiz * np.cos(a), R * np.cos(theta) - (R + eye_m)], axis=-1)


def test_site_grid_is_azimuthal_equidistant_with_exact_curvature(flat_moon):
    t = build_site_terrain(flat_moon, -20.0, 40.0, 5_000.0, eye_height_m=1.8, points_across=100,
                           max_range_m=20_000.0)
    x, y = np.meshgrid(t.site_xy_m, t.site_xy_m)
    expected = _expected_enu(np.degrees(np.arctan2(x, y)), np.hypot(x, y), 1.8)
    np.testing.assert_allclose(t.site_enu, expected, atol=1e-6)
    c = len(t.site_xy_m) // 2
    np.testing.assert_allclose(t.site_enu[c, c], [0, 0, -1.8], atol=1e-9)  # straight down to the feet
    assert t.ground_m == 0.0 and t.eye_m == 1.8


def test_far_mesh_has_exact_curvature_out_to_malapert_distance(flat_moon):
    t = build_site_terrain(flat_moon, -89.45, 222.69, 5_000.0, eye_height_m=1.8, points_across=50,
                           far_azimuth_step_deg=5.0, max_range_m=150_000.0)
    expected = _expected_enu(t.far_azimuth_deg[:, None], t.far_distance_m[None, :], 1.8)
    np.testing.assert_allclose(t.far_enu, expected, atol=1e-6)
    # 134 km away the ground is 2 R sin^2(d / 2R) = about 5.17 km below the eye's tangent plane.
    k = np.argmin(np.abs(t.far_distance_m - 134_000))
    d = t.far_distance_m[k]
    drop = 2 * R * np.sin(d / (2 * R)) ** 2
    assert t.far_enu[0, k, 2] == pytest.approx(-(drop + 1.8), abs=1e-6)
    assert drop == pytest.approx(d * d / (2 * R), rel=1e-3)


def test_grid_and_ring_layout():
    xy = site_grid_xy(5_000.0, 59.2)
    assert len(xy) % 2 == 1 and xy[len(xy) // 2] == 0
    assert xy[-1] >= 2_500 + 59.2 - 1e-9  # disc plus one cell
    rings = ring_distances(2_500.0, 300_000.0, 59.2, 0.01)
    assert rings[0] == 2_500 and rings[-1] == 300_000
    steps = np.diff(rings[:-1])
    np.testing.assert_allclose(steps, np.maximum(59.2, 0.01 * rings[:-2]))


def test_site_uses_fine_map_and_far_mesh_uses_coarse_map(make_polar, make_cylindrical):
    """Fine 20 m polar map near the pole, 240 m polar map out to ~156 km, coarse global
    map beyond. Site grid: only the fine map. Far mesh: never the fine map."""
    bump = lambda x, y: 0.5 * np.exp(-((x - 3e3) ** 2 + y ** 2) / 1e6)  # noqa: E731 (km)
    fine = DemProduct.open(make_polar(bump, n=1001, scale_m=20.0, stem="fine_float"))
    coarse = DemProduct.open(make_polar(bump, n=1301, scale_m=240.0, stem="coarse_float"))
    world = DemProduct.open(make_cylindrical(lambda lat, lon: np.zeros_like(lat), ppd=4))
    t = build_site_terrain([world, coarse, fine], -89.95, 0.0, 5_000.0, points_across=200,
                           far_azimuth_step_deg=2.0, max_range_m=150_000.0)
    assert t.site_map == "fine" and t.spacing_m == 25.0  # D / points_across, above 20 m
    assert set(np.unique(t.site_pixel_m)) == {20.0}
    assert 20.0 not in set(np.unique(t.far_pixel_m))
    assert 240.0 in set(np.unique(t.far_pixel_m))


def test_mesh_skyline_matches_the_ray_cast_skyline(make_polar):
    """A 3 km Gaussian mountain (sigma 9 km) about 45 km from a south-polar site, on a
    200 m map: where the mountain forms the skyline, the far mesh's highest vertex per
    azimuth matches lunar.skyline (the reference).

    Both sample the same bilinear surface; the mesh rings are 1 % of distance apart and
    the reference's 0.5 %, so near a smooth summit they differ only to second order."""
    peak_y = 45e3  # metres towards longitude 0 from the pole

    def mountain(x, y):
        return 3.0 * np.exp(-(x ** 2 + (y - peak_y) ** 2) / (2 * 9e3 ** 2))

    products = [DemProduct.open(make_polar(mountain, n=1201, scale_m=200.0))]
    lat0, lon0 = -89.9, 180.0  # 3 km from the pole on the far side from the mountain
    t = build_site_terrain(products, lat0, lon0, 5_000.0, points_across=100, far_azimuth_step_deg=0.5,
                           max_range_m=100_000.0)
    reference = compute_skyline(products, lat0, lon0, heights_above_ground_m=[1.8], azimuth_step_deg=0.5,
                                max_range_m=100_000.0)[0]
    assert np.allclose(reference.azimuth_deg, t.far_azimuth_deg)
    mesh = far_mesh_skyline(t)
    formed_far = reference.distance_m > 5_000
    assert formed_far.sum() >= 20
    diff = np.abs(mesh[formed_far] - reference.elevation_deg[formed_far])
    print(f"\nmesh vs ray-cast skyline over {formed_far.sum()} azimuths: max {diff.max():.4f} deg")
    assert diff.max() < 0.005


def test_payload_round_trip():
    arrays = {"a": np.arange(7, dtype=np.float32).reshape(7), "b": np.ones((2, 3, 3), np.float32),
              "m": np.array([[0, 1], [1, 0]], np.uint8)}
    header, back = terrain_payload.decode(terrain_payload.encode({"x": 1}, arrays))
    assert header["x"] == 1
    for k, v in arrays.items():
        np.testing.assert_array_equal(back[k], v)
        assert back[k].dtype == v.dtype
    assert all(b["offset"] % 8 == 0 for b in header["buffers"])


def test_endpoint_returns_binary_meshes_and_caches(flat_moon):
    client = TestClient(create_app(products=flat_moon))
    body = {"lat": 10.0, "lon": -20.0, "diameter_km": 5, "points_across": 60, "far_azimuth_step_deg": 5,
            "max_range_km": 50}
    r = client.post("/api/site/terrain", json=body)
    assert r.status_code == 200 and r.headers["content-type"] == "application/octet-stream"
    header, arrays = terrain_payload.decode(r.content)
    n, a, d = header["site_grid"]["points"], header["far_mesh"]["azimuths"], header["far_mesh"]["rings"]
    assert arrays["site_enu_m"].shape == (n, n, 3) and arrays["site_in_disc"].shape == (n, n)
    assert arrays["far_enu_m"].shape == (a, d, 3) and arrays["far_height_m"].shape == (a, d)
    assert header["site"]["lon"] == 340.0 and header["far_mesh"]["start_m"] == 2500.0
    assert client.post("/api/site/terrain", json=body).content == r.content  # served from cache


def test_endpoint_rejects_too_small_a_site(flat_moon):
    client = TestClient(create_app(products=flat_moon))
    r = client.post("/api/site/terrain", json={"lat": 0, "lon": 0, "diameter_km": 4})
    assert r.status_code == 422


def test_pinned_lola_product_supplies_the_site_and_panorama(make_polar, flat_moon):
    selected = replace(flat_moon[0], name="ldem_128")
    fine = DemProduct.open(make_polar(lambda x, y: np.ones_like(x), n=301, scale_m=200, stem="fine_float"))
    client = TestClient(create_app(products=[selected, fine]))
    body = {"lat": -90, "lon": 0, "include_panorama": True, "include_far_mesh": False,
            "max_range_km": 20, "far_azimuth_step_deg": 5}
    mixed = client.post("/api/site/terrain", json=body)
    pinned = client.post("/api/site/terrain", json={**body, "elevation_product": "ldem_128"})
    assert mixed.status_code == pinned.status_code == 200
    mixed_header, mixed_arrays = terrain_payload.decode(mixed.content)
    header, arrays = terrain_payload.decode(pinned.content)

    assert mixed_header["site"]["ground_m"] == pytest.approx(1000)
    assert header["site"]["ground_m"] == pytest.approx(0)
    assert header["elevation_product"] == header["site_grid"]["map"] == header["panorama"]["foreground_map"] == "ldem_128"
    assert not np.array_equal(arrays["ray_skyline_deg"], mixed_arrays["ray_skyline_deg"])
    assert not np.array_equal(arrays["panorama_shade"], mixed_arrays["panorama_shade"])


def test_lola_chain_blends_aligned_samples_and_uses_the_polar_grid_at_the_eye(make_polar, flat_moon):
    template = flat_moon[0]
    products = [
        replace(template, name=f"ldem_{ppd}", data=np.full_like(template.data, height), pixel_size_m=spacing)
        for ppd, height, spacing in [(512, 0.03, 59), (256, 0.02, 118), (128, 0.01, 237)]
    ]
    polar = DemProduct.open(make_polar(lambda x, y: np.full_like(x, 0.04), n=301, scale_m=5,
                                      stem="ldem_875s_5m_float"))
    products.append(polar)
    chain = LolaChain(products, -90, 0)
    distances = np.array([0, 480, 1000, 3000, 8000, 16000, 25000])
    lat, lon = destination(-90, 0, 0, distances)
    heights, _ = chain.sample(lat, lon, 0, distances)
    np.testing.assert_allclose(heights, [40, 35, 30, 25, 20, 15, 10], atol=1e-4)

    result = TestClient(create_app(products=products)).post("/api/site/terrain", json={
        "lat": -90, "lon": 0, "include_panorama": True, "include_far_mesh": False,
        "elevation_product": "lola_chain", "far_azimuth_step_deg": 5, "max_range_km": 30,
    })
    assert result.status_code == 200
    header, arrays = terrain_payload.decode(result.content)
    assert header["elevation_maps"] == ["ldem_875s_5m", "ldem_512", "ldem_256", "ldem_128"]
    assert header["site"]["ground_m"] == pytest.approx(40)
    assert np.isfinite(arrays["ray_skyline_deg"]).all()
    assert arrays["panorama_shade"].shape[1] == len(arrays["ray_skyline_deg"])


def test_ray_skyline_matches_lunar_skyline_on_the_same_map(make_polar):
    """The reference skyline the endpoint can return is the lunar.skyline method:
    on a single map they agree to rounding."""
    def mountain(x, y):
        return 3.0 * np.exp(-(x ** 2 + (y - 45e3) ** 2) / (2 * 9e3 ** 2))

    products = [DemProduct.open(make_polar(mountain, n=1201, scale_m=200.0))]
    t = build_site_terrain(products, -89.9, 180.0, 5_000.0, points_across=50, far_azimuth_step_deg=0.5,
                           max_range_m=100_000.0, with_ray_skyline=True)
    reference = compute_skyline(products, -89.9, 180.0, heights_above_ground_m=[1.8], azimuth_step_deg=0.5,
                                max_range_m=100_000.0, min_step_m=t.spacing_m / 2)[0]
    np.testing.assert_allclose(t.ray_skyline_deg, reference.elevation_deg, atol=1e-6)
    np.testing.assert_allclose(t.ray_skyline_distance_m, reference.distance_m)


def test_endpoint_can_include_the_ray_skyline(flat_moon):
    client = TestClient(create_app(products=flat_moon))
    body = {"lat": 0, "lon": 0, "diameter_km": 5, "points_across": 60, "far_azimuth_step_deg": 5,
            "max_range_km": 50, "include_ray_skyline": True}
    header, arrays = terrain_payload.decode(client.post("/api/site/terrain", json=body).content)
    assert arrays["ray_skyline_deg"].shape == (header["far_mesh"]["azimuths"],)
    # Bare sphere, eye 1.8 m up: the skyline is the nearest ground sample, below eye level.
    assert (arrays["ray_skyline_deg"] < 0).all()


def test_panorama_shades_nearest_visible_shade():
    distance = np.array([20.0, 80.0, 1000.0, 2000.0])
    elevation = np.array([5.0, -3.0, 12.0, 15.0])
    up = distance * np.tan(np.radians(elevation))
    relief = np.array([1.0, 0.0, 0.0, 0.0])

    # The dark wall behind a bright ridge only shows above the ridge's crest.
    shade = _visible_shade(elevation, distance, up, distance, relief, np.array([4.9, 5.1, 12.0]))
    assert shade[0] > 100 and shade[1] == shade[2] == 0


def test_panorama_corrects_isolated_peak_across_azimuth_wrap_without_erasing_ridge():
    bearings = np.arange(0, 360, 5)
    distance = np.arange(5, 40, 5)
    spacing = np.full(distance.shape, 16)
    heights = np.full((len(bearings), len(distance)), 100.0)
    heights[0, 2] = 122
    heights[30:35, 3] = 122
    heights[40:43, 2:5] = 122
    heights[10, 2] = 101
    low_strength = heights.copy()
    disabled = heights.copy()

    _correct_isolated_peaks(disabled, distance, bearings, spacing, strength=0)
    np.testing.assert_array_equal(disabled, heights)
    _correct_isolated_peaks(low_strength, distance, bearings, spacing, strength=60)
    _correct_isolated_peaks(heights, distance, bearings, spacing)

    assert heights[0, 2] == 100
    assert np.all(heights[30:35, 3] == 122)
    assert np.all(low_strength[40:43, 2:5] == 122)
    assert np.all(heights[40:43, 2:5] == 100)
    assert heights[10, 2] == 101


def test_panorama_includes_the_rim_outside_the_landing_site(make_polar):
    def mountain(x, y):
        return 3.0 * np.exp(-(x ** 2 + (y - 45e3) ** 2) / (2 * 9e3 ** 2))

    products = [DemProduct.open(make_polar(mountain, n=1201, scale_m=200.0))]
    client = TestClient(create_app(products=products))
    body = {"lat": -89.9, "lon": 180, "diameter_km": 5, "include_far_mesh": False, "include_panorama": True,
            "far_azimuth_step_deg": 2, "max_range_km": 100}
    response = client.post("/api/site/terrain", json=body)
    assert response.status_code == 200
    header, arrays = terrain_payload.decode(response.content)
    panorama = arrays["panorama_shade"]
    skyline = arrays["ray_skyline_deg"]
    assert header["panorama"]["spike_correction"] == 90
    assert panorama.shape == (header["panorama"]["rows"], len(skyline))
    assert panorama.dtype == np.uint8
    peak = np.argmax(skyline)
    assert skyline[peak] > 2 and arrays["ray_skyline_distance_m"][peak] > 2500
    assert np.ptp(panorama[:, peak]) > 0


def test_panorama_uses_finer_dem_at_the_observers_feet(make_polar):
    fine = DemProduct.open(make_polar(lambda x, y: 0.010 + x * 0, n=301, scale_m=5, stem="fine_float"))
    coarse = DemProduct.open(make_polar(lambda x, y: x * 0, n=301, scale_m=200, stem="coarse_float"))
    t = build_site_terrain([coarse, fine], -90, 0, 5_000, points_across=25, far_azimuth_step_deg=5,
                           max_range_m=20_000, with_far_mesh=False, with_panorama=True)

    assert t.site_map == "coarse" and t.foreground_map == "fine"
    assert t.ground_m == pytest.approx(10)
    centre = len(t.site_xy_m) // 2
    assert t.site_enu[centre, centre, 2] == pytest.approx(-t.eye_height_m)
    assert t.site_height_m[centre, centre + 3] == pytest.approx(0)


def test_foreground_correction_removes_isolated_disagreement_and_keeps_supported_ridge():
    reference = np.zeros((41, 41))
    reference[28:33, :] = 30
    detail = reference + 4
    detail[9:12, 9:12] += 36

    corrected = correct_outliers(detail, reference, step=2.5, pixel_size=5)

    np.testing.assert_allclose(corrected, reference + 4)


def test_site_only_payload_preserves_a_ridge_outside_the_footprint(make_polar):
    def mountain(x, y):
        return 3.0 * np.exp(-(x ** 2 + (y - 45e3) ** 2) / (2 * 9e3 ** 2))

    products = [DemProduct.open(make_polar(mountain, n=1201, scale_m=200.0))]
    client = TestClient(create_app(products=products))
    body = {"lat": -89.9, "lon": 180, "diameter_km": 5, "max_range_km": 100, "include_ray_skyline": True}
    full = client.post("/api/site/terrain", json=body)
    trimmed = client.post("/api/site/terrain", json={**body, "include_far_mesh": False})
    assert full.status_code == trimmed.status_code == 200
    _, reference = terrain_payload.decode(full.content)
    header, arrays = terrain_payload.decode(trimmed.content)

    assert header["far_mesh"] is None
    assert not any(name.startswith("far_") for name in arrays)
    assert np.isfinite(arrays["site_enu_m"][arrays["site_in_disc"].astype(bool)]).all()
    np.testing.assert_array_equal(arrays["ray_skyline_deg"], reference["ray_skyline_deg"])
    np.testing.assert_array_equal(arrays["ray_skyline_distance_m"], reference["ray_skyline_distance_m"])
    peak = np.argmax(arrays["ray_skyline_deg"])
    assert arrays["ray_skyline_deg"][peak] > 2
    assert arrays["ray_skyline_distance_m"][peak] > 2500


def _sphere_normal(az_deg, d_m):
    a, theta = np.radians(az_deg), np.asarray(d_m) / R
    return np.stack(np.broadcast_arrays(np.sin(theta) * np.sin(a), np.sin(theta) * np.cos(a), np.cos(theta)), axis=-1)


def test_normals_on_the_bare_sphere_are_the_local_vertical_in_the_site_frame():
    # Bare sphere seen from an eye 1.8 m up: H = R sin(d/R), U = R cos(d/R) - R - 1.8.
    az = np.arange(0.0, 360.0, 0.25)
    d = np.linspace(10.0, 300_000.0, 6000)
    theta = d / R
    horizontal = np.broadcast_to(R * np.sin(theta), (len(az), len(d))).copy()
    up = np.broadcast_to(R * np.cos(theta) - R - 1.8, (len(az), len(d))).copy()
    n = _normals(horizontal, up, d, az, np.full(d.shape, 100.0))
    expected = _sphere_normal(az[:, None], d[None, :])
    angle = np.degrees(np.arccos(np.clip(np.sum(n * expected, axis=-1), -1, 1)))
    assert angle[:, 1:-1].max() < 1e-4  # degrees; 300 km away the vertical has turned 9.89 deg
    assert np.degrees(np.arccos(n[0, -2, 2])) == pytest.approx(np.degrees(d[-2] / R), abs=1e-4)


def test_normals_of_a_tilted_plane():
    # A plane rising northwards with slope s (no curvature): U = s * north - eye.
    s = 0.2
    az = np.arange(0.0, 360.0, 0.5)
    d = np.linspace(5.0, 2_000.0, 800)
    a = np.radians(az)[:, None]
    horizontal = np.broadcast_to(d, (len(az), len(d))).copy()
    up = s * d[None, :] * np.cos(a) - 1.8
    n = _normals(horizontal, up, d, az, np.full(d.shape, 5.0))
    expected = np.array([0.0, -s, 1.0]) / np.hypot(s, 1.0)
    assert np.abs(n[:, 1:-1] - expected).max() < 1e-9


def test_foreground_normals_include_the_curvature():
    az = np.arange(0.0, 360.0, 10.0)
    d = np.array([1.0, 100.0, 320.0])
    zero = np.zeros((len(az), len(d)))
    np.testing.assert_allclose(_foreground_normals(zero, zero, az, d), _sphere_normal(az[:, None], d[None, :]),
                               atol=1e-15)
    # A slope of 0.1 east at the site itself: normal (0.1, 0, 1) / |.|.
    n = _foreground_normals(np.full((1, 1), 0.1), np.zeros((1, 1)), np.array([0.0]), np.array([0.0]))
    np.testing.assert_allclose(n[0, 0], np.array([0.1, 0.0, 1.0]) / np.hypot(0.1, 1.0), atol=1e-15)


def test_panorama_normals_on_the_bare_sphere(flat_moon):
    t = build_site_terrain(flat_moon, 10.0, 20.0, 5_000, points_across=25, far_azimuth_step_deg=5,
                           max_range_m=20_000, with_far_mesh=False, with_panorama=True)
    normal = t.panorama_normal.astype(float)
    assert t.panorama_normal.dtype == np.float16
    assert normal.shape == (*t.panorama_shade.shape, 2)
    # Bare sphere: each normal leans away from the eye along its own bearing, never across it.
    a = np.radians(t.far_azimuth_deg)[None, :]
    across = normal[..., 0] * np.cos(a) - normal[..., 1] * np.sin(a)
    along = normal[..., 0] * np.sin(a) + normal[..., 1] * np.cos(a)
    assert np.abs(across).max() < 2e-4
    # ... by at most theta = d/R for the visible ground (within 20 km here; float16 rounding 5e-4).
    assert along.min() > -5e-4 and along.max() < 20_000 / R + 5e-4

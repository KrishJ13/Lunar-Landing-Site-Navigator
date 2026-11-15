"""Remote LOLA reading: multipart parsing, block grid, mosaics, product choice.

Offline tests serve byte ranges from in-memory arrays through the same code
path the HTTP fetcher feeds, so everything except the socket is exercised.
"""

import numpy as np
import pytest

from lunar.dem import DemProduct, heights_at
from lunar.dem import remote
from lunar.dem.pds_label import parse_label
from lunar.dem.remote import RemoteGrid, RemoteSpec, Tile, open_remote, parse_multipart_byteranges


class ArrayFetcher:
    """Serves inclusive byte ranges of in-memory .img files, like the PDS server."""

    def __init__(self, files: dict[str, bytes]):
        self.files = files
        self.requests = 0

    def fetch(self, url, ranges):
        self.requests += 1
        data = self.files[url]
        return {a: data[a:b + 1] for a, b in ranges}


@pytest.fixture
def small_blocks(monkeypatch):
    monkeypatch.setattr(remote, "BLOCK", 8)


# ---------- multipart ----------


def test_multipart_parser_reads_parts_by_length_even_if_data_contains_boundary():
    boundary = b"XYZ"
    payload = b"ab--XYZcd"  # contains the delimiter on purpose
    body = (
        b"--XYZ\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 10-18/100\r\n\r\n"
        + payload + b"\r\n--XYZ\r\nContent-Range: bytes 40-42/100\r\n\r\nefg\r\n--XYZ--\r\n"
    )
    assert parse_multipart_byteranges(body, boundary) == {10: payload, 40: b"efg"}


def test_slice_ranges_handles_merged_parts():
    parts = {100: bytes(range(20))}  # server merged 100-109 and 110-119 into one part
    out = remote._slice_ranges(parts, [(100, 109), (110, 119)], "u")
    assert out == {100: bytes(range(10)), 110: bytes(range(10, 20))}


# ---------- grid ----------


def test_grid_gathers_exactly_and_caches_blocks(tmp_path, small_blocks):
    rng = np.random.default_rng(1)
    full = rng.normal(size=(37, 53)).astype("<f4")  # sizes NOT multiples of the block
    fetcher = ArrayFetcher({"u": full.tobytes()})
    grid = RemoteGrid("g", 37, 53, [Tile("u", 0, 0, 37, 53)], tmp_path, fetcher)

    rows = rng.integers(0, 37, 500)
    cols = rng.integers(0, 53, 500)
    np.testing.assert_array_equal(grid[rows, cols], full[rows, cols])
    np.testing.assert_array_equal(grid.window(0, 37, 0, 53), full)
    fetched = grid.blocks_fetched
    assert fetched == 5 * 7  # every block once, edge blocks included

    # A new grid on the same cache folder reads from disk, not the network.
    again = RemoteGrid("g", 37, 53, [Tile("u", 0, 0, 37, 53)], tmp_path, ArrayFetcher({}))
    np.testing.assert_array_equal(again[rows, cols], full[rows, cols])
    assert again.blocks_fetched == 0


def test_grid_rejects_out_of_range(tmp_path, small_blocks):
    grid = RemoteGrid("g", 8, 8, [Tile("u", 0, 0, 8, 8)], tmp_path, ArrayFetcher({"u": bytes(256)}))
    with pytest.raises(IndexError):
        grid[np.array([8]), np.array([0])]


# ---------- mosaic ----------

TILE_LABEL = """PDS_VERSION_ID = "PDS3"
OBJECT = IMAGE
  LINES = {lines}
  LINE_SAMPLES = {samples}
  SAMPLE_TYPE = PC_REAL
  SAMPLE_BITS = 32
  UNIT = KILOMETER
  SCALING_FACTOR = 1
END_OBJECT = IMAGE
OBJECT = IMAGE_MAP_PROJECTION
 MAP_PROJECTION_TYPE = "SIMPLE CYLINDRICAL"
 MAP_RESOLUTION = {ppd} <pix/deg>
 CENTER_LATITUDE = 0. <deg>
 CENTER_LONGITUDE = 180. <deg>
 MAP_SCALE = {scale} <km/pix>
 MAXIMUM_LATITUDE = {maxlat} <deg>
 WESTERNMOST_LONGITUDE = {west} <deg>
 EASTERNMOST_LONGITUDE = {east} <deg>
 LINE_PROJECTION_OFFSET = {line_off} <pix>
 SAMPLE_PROJECTION_OFFSET = {sample_off} <pix>
END_OBJECT = IMAGE_MAP_PROJECTION
END
"""


def _mosaic(ppd=4, shift_one_tile=False, band_only=False):
    """A 2 x 2 tiled global map, labelled the way PDS labels the LDEM_512 tiles.
    band_only: two tiles covering 45S-45N only, like SLDEM2015's +/-60 deg."""
    lines, samples = 180 * ppd, 360 * ppd
    r, c = np.mgrid[0:lines, 0:samples]
    lat = 90 - (r + 0.5) / ppd
    lon = (c + 0.5) / ppd
    full = (np.sin(np.radians(lat * 3)) + np.cos(np.radians(lon * 2))).astype("<f4")
    files, labels, stems = {}, {}, []
    tile_lat = 90  # degrees of latitude per tile: 90N-0 and 0-90S, or 45N-45S for the band
    for maxlat in ((45,) if band_only else (90, 0)):
        for west in (0, 180):
            stem = f"t_{maxlat}_{west}"
            row0, col0 = (90 - maxlat) * ppd, west * ppd
            tile = full[row0:row0 + tile_lat * ppd, col0:col0 + 180 * ppd]
            line_off = (lines / 2 - 0.5) - row0 + (1 if shift_one_tile and stem == "t_0_180" else 0)
            labels[stem] = TILE_LABEL.format(
                lines=tile_lat * ppd, samples=180 * ppd, ppd=ppd, scale=1737.4 * np.pi / 180 / ppd,
                maxlat=maxlat, west=west, east=west + 180,
                line_off=line_off, sample_off=(samples / 2 - 0.5) - col0,
            )
            stems.append(stem)
            files[f"https://x/{stem}.img"] = tile.tobytes()
    spec = RemoteSpec("mosaic", 1737.4e3 * np.pi / 180 / ppd, "cylindrical", tuple(stems))
    spec_url = lambda stem, suffix: f"https://x/{stem}.{suffix}"  # noqa: E731
    object.__setattr__(spec, "url", spec_url)
    loader = lambda spec, stem, cache: parse_label(labels[stem])  # noqa: E731
    return full, spec, files, loader


def test_mosaic_matches_one_global_grid_across_tile_seams(tmp_path, small_blocks):
    full, spec, files, loader = _mosaic()
    product = open_remote(spec, tmp_path, ArrayFetcher(files), loader)
    assert product.shape == full.shape
    assert product.projection.line_offset == pytest.approx(full.shape[0] / 2 - 0.5)

    # Points along both seams (lat 0, lon 0/180) and at random.
    rng = np.random.default_rng(2)
    lat = np.concatenate([np.zeros(50), rng.uniform(-89, 89, 200)])
    lon = np.concatenate([np.linspace(170, 190, 50), rng.uniform(0, 360, 200)])
    lat = np.concatenate([lat, rng.uniform(-60, 60, 30)])
    lon = np.concatenate([lon, np.full(30, 359.99)])  # wraps to 0

    local = DemProduct("ref", product.projection, full, product.pixel_size_m)
    np.testing.assert_allclose(product.heights_m(lat, lon), local.heights_m(lat, lon), rtol=0, atol=1e-9)


def test_mosaic_refuses_a_tile_whose_label_does_not_fit(tmp_path, small_blocks):
    _, spec, files, loader = _mosaic(shift_one_tile=True)
    with pytest.raises(ValueError, match="does not fit"):
        open_remote(spec, tmp_path, ArrayFetcher(files), loader)


# ---------- choosing a product by spacing ----------


class Flat:
    """Constant-height stand-in product of a given pixel size and coverage."""

    def __init__(self, pixel_m, height, lat_min=-90.0, remote_=False):
        self.pixel_size_m, self.height, self.lat_min, self.is_remote = pixel_m, height, lat_min, remote_
        self.calls = 0

    def contains(self, lat, lon):
        return np.asarray(lat) >= self.lat_min

    def heights_m(self, lat, lon, method="bilinear"):
        self.calls += 1
        lat = np.asarray(lat)
        return np.where(lat >= self.lat_min, float(self.height), np.nan)


def test_target_spacing_picks_closest_product_from_below():
    p5, p20, p60, p240 = Flat(5, 5, lat_min=80), Flat(20, 20, lat_min=80), Flat(60, 60), Flat(240, 240)
    products = [p5, p20, p60, p240]
    lat = np.array([85.0, 85.0, 85.0, 85.0, 0.0])
    target = np.array([25.0, 300.0, 5.0, 2.0, 25.0])
    h, px = heights_at(products, lat, np.zeros(5), target_m=target)
    # 25 m -> 20 m map; 300 m -> 240 m; 5 m -> 5 m; 2 m -> finest available (5 m);
    # 25 m at lat 0 -> nothing that fine covers it -> finest coarser (60 m).
    np.testing.assert_array_equal(h, [20, 240, 5, 5, 60])
    np.testing.assert_array_equal(px, [20, 240, 5, 5, 60])


def test_no_target_keeps_finest_first_behaviour():
    products = [Flat(240, 240), Flat(20, 20, lat_min=80)]
    h, _ = heights_at(products, np.array([85.0, 0.0]), np.zeros(2))
    np.testing.assert_array_equal(h, [20, 240])


def test_local_file_wins_a_tie_with_remote():
    local, remote_ = Flat(240, 1), Flat(240, 2, remote_=True)
    h, _ = heights_at([remote_, local], np.array([0.0]), np.array([0.0]), target_m=500)
    assert h[0] == 1 and remote_.calls == 0


def test_remote_specs_cover_published_products():
    names = {s.name for s in remote.remote_specs()}
    assert {"ldem_512", "ldem_256", "ldem_128", "ldem_875s_5m", "ldem_80s_20m", "ldem_60n_60m"} <= names
    spec = next(s for s in remote.remote_specs() if s.name == "ldem_512")
    assert len(spec.stems) == 16
    # 2 pi R / (360 * 512) with R = 1737.4 km; the label's MAP_SCALE is 0.0592252938 km/pix.
    assert spec.pixel_size_m == pytest.approx(59.2252938, abs=1e-6)


def test_default_maps_are_sldem2015_for_the_site_and_ldem_128_beyond(tmp_path):
    """With the default product set, a site-spacing target picks SLDEM2015 (512 px/deg)
    and any target of 237 m or more picks ldem_128. No network: the choice is made
    from nominal pixel sizes before anything is opened."""
    from lunar.dem.catalog import _preference

    products = remote.load_remote(tmp_path)
    glob = [p for p in products if p.spec.folder == "cylindrical"]
    assert {p.name for p in glob} == {"sldem2015_512", "ldem_128"}
    assert _preference(glob, 60.0)[0].name == "sldem2015_512"
    for far_target in (237.0, 500.0, 1500.0):
        assert _preference(glob, far_target)[0].name == "ldem_128"


def test_sldem2015_spec_matches_the_published_tiles():
    spec = next(s for s in remote.remote_specs() if s.name == "sldem2015_512")
    assert len(spec.stems) == 32 and spec.max_abs_lat == 60.0
    assert "sldem2015_512_60s_30s_315_360" in spec.stems and "sldem2015_512_30n_60n_000_045" in spec.stems
    assert spec.url("sldem2015_512_00n_30n_000_045", "img").endswith(
        "/sldem2015/tiles/float_img/sldem2015_512_00n_30n_000_045_float.img")


def test_latitude_limited_mosaic_covers_only_its_band(tmp_path, small_blocks):
    """Tiles only between 45S and 45N, placed in a whole-Moon grid: points outside the
    band are not covered (NaN, so another map is used), points inside match the data
    exactly, including right at the band edges."""
    ppd = 8  # band edge (row 45 * 8 = 360) falls on an 8-pixel block boundary
    full, spec, files, loader = _mosaic(ppd=ppd, band_only=True)
    product = open_remote(spec, tmp_path, ArrayFetcher(files), loader)
    assert product.valid_lines == (45 * ppd, 135 * ppd - 1)

    outside = product.heights_m(np.array([50.0, -60.0, 89.0]), np.array([10.0, 200.0, 0.0]))
    assert np.isnan(outside).all()
    assert not product.contains(50.0, 10.0).any()

    lat = np.array([0.0, 44.8, -44.8, 30.0, -12.3])  # 44.9375 is the last pixel centre
    lon = np.array([0.0, 100.0, 359.0, 180.0, 75.0])
    reference = DemProduct("ref", product.projection, full, product.pixel_size_m)
    np.testing.assert_allclose(product.heights_m(lat, lon), reference.heights_m(lat, lon), atol=1e-9)

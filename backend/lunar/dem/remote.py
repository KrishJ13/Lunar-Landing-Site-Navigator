"""Read windows of LOLA maps straight from the PDS server, without downloading whole files.

The LOLA .img files are raw little-endian float32 grids stored row by row, and
the PDS Geosciences server answers HTTP byte-range requests, including several
ranges in one request (multipart/byteranges; checked 2026-11-15 with up to 512
ranges). So a block of the grid is one request listing one byte range per row.

RemoteGrid is a lazy (lines, samples) float32 array that DemProduct can use in
place of its memory-mapped .img. It is split into BLOCK x BLOCK pixel blocks.
A block is fetched the first time any of its pixels is read, kept in memory
(least recently used first out), and saved under the cache folder, so each
block crosses the network once.

A grid can be a mosaic of several tiles (e.g. LDEM_512, which PDS publishes
as 16 tiles). Pixels are then addressed in one global grid and each block is
read from the tile that holds it, so tile seams need no special handling.
"""

from __future__ import annotations

import logging
import re
import ssl
import threading
import time
import urllib.request
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .pds_label import find_object, read_label
from .product import DemProduct, _build_projection, _check_image_format
from .projections import SimpleCylindrical

log = logging.getLogger(__name__)

BLOCK = 256  # pixels per block side; 256 x 256 float32 = 256 KB
MAX_RANGES_PER_REQUEST = 512  # the PDS server accepts at least this many
MEMORY_BLOCKS = 512  # in-memory LRU size (512 blocks = 128 MB)
LABEL_WORKERS = 6  # parallel label downloads when a mosaic is first opened
FETCH_WORKERS = 4  # parallel block-row requests


# ---------- HTTP ----------


def ssl_context() -> ssl.SSLContext:
    """python.org builds on macOS often lack a CA bundle; certifi provides one."""
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:  # pragma: no cover
        return ssl.create_default_context()


_CONTENT_RANGE = re.compile(rb"content-range:\s*bytes\s+(\d+)-(\d+)/(\d+|\*)", re.IGNORECASE)


def parse_multipart_byteranges(body: bytes, boundary: bytes) -> dict[int, bytes]:
    """Split a multipart/byteranges body into {start offset: bytes}.

    Each part is read by the length its Content-Range header states, so binary
    data that happens to contain the boundary string cannot break parsing.
    """
    out: dict[int, bytes] = {}
    delimiter = b"--" + boundary
    pos = body.find(delimiter)
    while pos != -1:
        pos += len(delimiter)
        if body[pos:pos + 2] == b"--":  # closing delimiter
            break
        header_end = body.find(b"\r\n\r\n", pos)
        if header_end == -1:
            raise ValueError("malformed multipart/byteranges part (no header end)")
        match = _CONTENT_RANGE.search(body[pos:header_end])
        if not match:
            raise ValueError("multipart/byteranges part without Content-Range")
        start, end = int(match[1]), int(match[2])
        data_start = header_end + 4
        data = body[data_start:data_start + end - start + 1]
        if len(data) != end - start + 1:
            raise ValueError("truncated multipart/byteranges part")
        out[start] = data
        pos = body.find(delimiter, data_start + len(data))
    return out


class HttpRangeFetcher:
    """Fetch byte ranges of a URL, several per request, with retries."""

    def __init__(self, retries: int = 5, timeout_s: float = 15.0):
        self.retries = retries
        self.timeout_s = timeout_s
        self._context = ssl_context()

    def fetch(self, url: str, ranges: list[tuple[int, int]]) -> dict[int, bytes]:
        """Return {start: bytes} for inclusive (start, end) byte ranges."""
        out: dict[int, bytes] = {}
        for i in range(0, len(ranges), MAX_RANGES_PER_REQUEST):
            out.update(self._fetch_batch(url, ranges[i:i + MAX_RANGES_PER_REQUEST]))
        return out

    def _fetch_batch(self, url: str, ranges: list[tuple[int, int]]) -> dict[int, bytes]:
        header = "bytes=" + ",".join(f"{a}-{b}" for a, b in ranges)
        request = urllib.request.Request(url, headers={"Range": header})
        for attempt in range(1, self.retries + 1):
            # PDS sometimes stalls one connection and serves the same block
            # immediately on retry. Allow the full timeout on subsequent tries.
            timeout = min(self.timeout_s, 5.0) if attempt == 1 and self.retries > 1 else self.timeout_s
            try:
                with urllib.request.urlopen(request, context=self._context, timeout=timeout) as response:
                    if response.status != 206:
                        raise IOError(f"{url}: expected 206 Partial Content, got {response.status}")
                    content_type = response.headers.get("Content-Type", "")
                    body = response.read()
                if content_type.startswith("multipart/byteranges"):
                    boundary = content_type.split("boundary=", 1)[1].strip().strip('"').encode()
                    parts = parse_multipart_byteranges(body, boundary)
                else:  # one range (or the server merged them into one)
                    match = re.match(r"bytes (\d+)-(\d+)/", response.headers.get("Content-Range", ""))
                    if not match:
                        raise IOError(f"{url}: single-part response without Content-Range")
                    parts = {int(match[1]): body}
                return _slice_ranges(parts, ranges, url)
            except (OSError, ValueError) as exc:
                if attempt == self.retries:
                    raise
                log.warning("range request to %s failed (%s); retry %d", url, exc, attempt)
                time.sleep(2 ** (attempt - 1))  # 1, 2, 4, 8 s
        raise AssertionError("unreachable")


def _slice_ranges(parts: dict[int, bytes], ranges: list[tuple[int, int]], url: str) -> dict[int, bytes]:
    """Cut each requested range out of the returned parts (servers may merge adjacent ranges)."""
    starts = sorted(parts)
    out = {}
    for a, b in ranges:
        # the part that starts at or before a
        k = np.searchsorted(starts, a, side="right") - 1
        if k < 0:
            raise IOError(f"{url}: range {a}-{b} missing from response")
        s = starts[k]
        data = parts[s][a - s:b - s + 1]
        if len(data) != b - a + 1:
            raise IOError(f"{url}: range {a}-{b} missing from response")
        out[a] = data
    return out


# ---------- grid ----------


@dataclass(frozen=True)
class Tile:
    """One remote .img file placed in the global grid at (row0, col0)."""

    url: str
    row0: int
    col0: int
    lines: int
    samples: int


class RemoteGrid:
    """Lazy float32 grid read block by block over HTTP. Indexable like a 2-D array
    with a pair of integer index arrays: grid[rows, cols]."""

    def __init__(self, name: str, lines: int, samples: int, tiles: list[Tile], cache_dir: Path,
                 fetcher: HttpRangeFetcher | None = None, memory_blocks: int = MEMORY_BLOCKS):
        for t in tiles:
            if t.row0 % BLOCK or t.col0 % BLOCK:
                raise ValueError(f"{name}: tile origin must be a multiple of {BLOCK}")
        self.name = name
        self.shape = (lines, samples)
        self.dtype = np.dtype("<f4")
        self.tiles = tiles
        self.cache_dir = Path(cache_dir) / name
        self.fetcher = fetcher or HttpRangeFetcher()
        self._memory: OrderedDict[tuple[int, int], np.ndarray] = OrderedDict()
        self._memory_blocks = memory_blocks
        self._lock = threading.Lock()
        self.blocks_fetched = 0  # network block reads, for tests and logging

    # ----- indexing -----

    def __getitem__(self, key):
        rows, cols = key
        rows, cols = np.broadcast_arrays(np.asarray(rows, dtype=np.int64), np.asarray(cols, dtype=np.int64))
        lines, samples = self.shape
        if rows.size and (rows.min() < 0 or rows.max() >= lines or cols.min() < 0 or cols.max() >= samples):
            raise IndexError(f"{self.name}: index outside grid {self.shape}")
        out = np.empty(rows.shape, dtype=self.dtype)
        if rows.size == 0:
            return out
        br, bc = rows // BLOCK, cols // BLOCK
        key_ids = br * ((samples + BLOCK - 1) // BLOCK) + bc
        unique, inverse = np.unique(key_ids.ravel(), return_inverse=True)
        blocks = [(int(k) // ((samples + BLOCK - 1) // BLOCK), int(k) % ((samples + BLOCK - 1) // BLOCK)) for k in unique]
        loaded = self.blocks(blocks)
        flat_out = out.ravel()
        flat_r, flat_c = rows.ravel(), cols.ravel()
        order = np.argsort(inverse, kind="stable")
        bounds = np.searchsorted(inverse[order], np.arange(len(unique) + 1))
        for i, b in enumerate(blocks):
            idx = order[bounds[i]:bounds[i + 1]]
            data = loaded[b]
            flat_out[idx] = data[flat_r[idx] - b[0] * BLOCK, flat_c[idx] - b[1] * BLOCK]
        return out

    def window(self, row0: int, row1: int, col0: int, col1: int) -> np.ndarray:
        """Dense copy of rows [row0, row1) x cols [col0, col1), assembled block by
        block (slice copies, no per-pixel indexing)."""
        out = np.empty((row1 - row0, col1 - col0), dtype=self.dtype)
        wanted = [(br, bc) for br in range(row0 // BLOCK, (row1 - 1) // BLOCK + 1)
                  for bc in range(col0 // BLOCK, (col1 - 1) // BLOCK + 1)]
        loaded = self.blocks(wanted)
        for (br, bc), data in loaded.items():
            r0, c0 = br * BLOCK, bc * BLOCK
            rs, re = max(row0, r0), min(row1, r0 + data.shape[0])
            cs, ce = max(col0, c0), min(col1, c0 + data.shape[1])
            out[rs - row0:re - row0, cs - col0:ce - col0] = data[rs - r0:re - r0, cs - c0:ce - c0]
        return out

    # ----- blocks -----

    def blocks(self, wanted: list[tuple[int, int]]) -> dict[tuple[int, int], np.ndarray]:
        with self._lock:
            out, missing = {}, []
            for b in wanted:
                data = self._memory.get(b)
                if data is None:
                    data = self._load_cached(b)
                if data is None:
                    missing.append(b)
                else:
                    out[b] = data
                    self._remember(b, data)
            if missing:
                for b, data in self._fetch(missing).items():
                    self._save_cached(b, data)
                    self._remember(b, data)
                    out[b] = data
            return out

    def _block_extent(self, b):
        lines, samples = self.shape
        r0, c0 = b[0] * BLOCK, b[1] * BLOCK
        return r0, min(r0 + BLOCK, lines), c0, min(c0 + BLOCK, samples)

    def _tile_for(self, row: int, col: int) -> Tile:
        for t in self.tiles:
            if t.row0 <= row < t.row0 + t.lines and t.col0 <= col < t.col0 + t.samples:
                return t
        raise IndexError(f"{self.name}: no tile holds pixel ({row}, {col})")

    def _fetch(self, missing: list[tuple[int, int]]) -> dict[tuple[int, int], np.ndarray]:
        """Fetch blocks; one request (per 512 ranges) per tile and block row, merging
        neighbouring blocks in a row into one byte range per image row."""
        groups: dict[tuple[Tile, int], list[int]] = {}
        for b in missing:
            r0, _, c0, _ = self._block_extent(b)
            groups.setdefault((self._tile_for(r0, c0), b[0]), []).append(b[1])
        # One request per (tile, block row); up to FETCH_WORKERS of them at once.
        out = {}
        with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
            for blocks in pool.map(lambda item: self._fetch_band(*item[0], item[1]), groups.items()):
                out.update(blocks)
                self.blocks_fetched += len(blocks)
        return out

    def _fetch_band(self, tile: Tile, brow: int, bcols: list[int]) -> dict[tuple[int, int], np.ndarray]:
        """All wanted blocks of one block row of one tile, in one request: one byte range
        per image row for each run of neighbouring blocks."""
        bcols = sorted(bcols)
        runs, run = [], [bcols[0]]
        for c in bcols[1:]:
            if c == run[-1] + 1:
                run.append(c)
            else:
                runs.append(run)
                run = [c]
        runs.append(run)
        r0, r1, _, _ = self._block_extent((brow, bcols[0]))
        ranges, spans = [], []
        for run in runs:
            _, _, c0, _ = self._block_extent((brow, run[0]))
            _, _, _, c1 = self._block_extent((brow, run[-1]))
            spans.append((run, c0, c1))
            for row in range(r0, r1):
                start = ((row - tile.row0) * tile.samples + (c0 - tile.col0)) * 4
                ranges.append((start, start + (c1 - c0) * 4 - 1))
        t_start = time.perf_counter()
        parts = self.fetcher.fetch(tile.url, ranges)
        log.info("%s: fetched %d block(s) in %.2f s", self.name,
                 sum(len(r) for r, _, _ in spans), time.perf_counter() - t_start)
        out = {}
        for run, c0, c1 in spans:
            band = np.empty((r1 - r0, c1 - c0), dtype=self.dtype)
            for i, row in enumerate(range(r0, r1)):
                start = ((row - tile.row0) * tile.samples + (c0 - tile.col0)) * 4
                band[i] = np.frombuffer(parts[start], dtype=self.dtype)
            for c in run:
                _, _, bc0, bc1 = self._block_extent((brow, c))
                out[(brow, c)] = np.ascontiguousarray(band[:, bc0 - c0:bc1 - c0])
        return out

    # ----- caches -----

    def _remember(self, b, data):
        self._memory[b] = data
        self._memory.move_to_end(b)
        while len(self._memory) > self._memory_blocks:
            self._memory.popitem(last=False)

    def _cache_path(self, b) -> Path:
        return self.cache_dir / f"{b[0]}_{b[1]}.npy"

    def _load_cached(self, b):
        path = self._cache_path(b)
        if not path.exists():
            return None
        try:
            data = np.load(path)
        except (OSError, ValueError):  # partial or corrupt file: fetch again
            return None
        r0, r1, c0, c1 = self._block_extent(b)
        return data if data.shape == (r1 - r0, c1 - c0) else None

    def _save_cached(self, b, data):
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        path = self._cache_path(b)
        tmp = path.with_name(path.name + ".part")
        with open(tmp, "wb") as f:
            np.save(f, data)
        tmp.replace(path)  # atomic: readers never see half a block


# ---------- remote LOLA products ----------
#
# Every product the PDS LOLA GDR volume publishes as float32 grids, checked
# against the server listing on 2026-11-15. Pixel sizes are the nominal ones
# from the names; the label's MAP_SCALE is used once a product is opened.

LOLA_GDR_BASE = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr"
SLDEM_TILES_BASE = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/sldem2015/tiles/float_img"

# polar stereographic: (latitude band, pixel sizes in metres), both hemispheres
POLAR_PRODUCTS = {
    "45": (45.0, (100, 200, 400)),
    "60": (60.0, (60, 120, 240)),
    "75": (75.0, (30, 60, 120, 240)),
    "80": (80.0, (20, 40, 80)),
    "85": (85.0, (10, 20, 40)),
    "875": (87.5, (5, 10, 20)),
}

# global simple cylindrical: pixels per degree -> tile stems (None = one global file)
_LAT_512 = ("45n_90n", "00n_45n", "45s_00s", "90s_45s")
_LON_512 = ("000_090", "090_180", "180_270", "270_360")
GLOBAL_PRODUCTS = {
    512: tuple(f"ldem_512_{a}_{o}" for a in _LAT_512 for o in _LON_512),
    256: tuple(f"ldem_256_{a}_{o}" for a in ("00n_90n", "90s_00s") for o in ("000_180", "180_360")),
    128: None,
    64: None,
}

# SLDEM2015 (Barker et al. 2016): LOLA co-registered with SELENE (Kaguya) Terrain
# Camera stereo, which fills the gaps between LOLA tracks. 512 px/deg (59.2 m at
# the equator), latitudes within +/-60 deg, 32 tiles of 30 deg x 45 deg. Same
# float32 / km / 1737.4 km sphere / pixel-registered layout as the LDEM tiles.
_LAT_SLDEM = ("30n_60n", "00n_30n", "30s_00s", "60s_30s")
_LON_SLDEM = tuple(f"{w:03d}_{w + 45:03d}" for w in range(0, 360, 45))
SLDEM_512_STEMS = tuple(f"sldem2015_512_{a}_{o}" for a in _LAT_SLDEM for o in _LON_SLDEM)


@dataclass(frozen=True)
class RemoteSpec:
    name: str  # e.g. "ldem_80s_20m", "ldem_512"
    pixel_size_m: float  # nominal
    folder: str  # "polar" or "cylindrical"
    stems: tuple[str, ...]  # file stems without "_float"
    min_abs_lat: float = 0.0  # polar products: nominal coverage |lat| >= this
    south: bool | None = None  # polar products: hemisphere
    max_abs_lat: float = 90.0  # latitude-limited maps (SLDEM2015: 60)
    base: str | None = None  # folder URL, if not the LOLA GDR one

    def url(self, stem: str, suffix: str) -> str:
        base = self.base or f"{LOLA_GDR_BASE}/{self.folder}/float_img"
        return f"{base}/{stem}_float.{suffix}"


def remote_specs() -> list[RemoteSpec]:
    specs = []
    for band, (lat, sizes) in POLAR_PRODUCTS.items():
        for hemi in ("s", "n"):
            for size in sizes:
                name = f"ldem_{band}{hemi}_{size}m"
                specs.append(RemoteSpec(name, float(size), "polar", (name,), lat, hemi == "s"))
    for ppd, tiles in GLOBAL_PRODUCTS.items():
        name = f"ldem_{ppd}"
        # 2 pi R / (360 ppd), R = 1737.4 km
        size = 2 * np.pi * 1_737_400.0 / (360 * ppd)
        specs.append(RemoteSpec(name, size, "cylindrical", tiles or (name,)))
    specs.append(RemoteSpec("sldem2015_512", 2 * np.pi * 1_737_400.0 / (360 * 512), "cylindrical",
                            SLDEM_512_STEMS, max_abs_lat=60.0, base=SLDEM_TILES_BASE))
    return specs


def _get_with_retries(url: str, retries: int = 5, timeout_s: float = 8.0) -> bytes:
    """GET a small file. The PDS server sometimes refuses connections in bursts,
    so retry with exponential backoff (1, 2, 4, 8 s)."""
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, context=ssl_context(), timeout=timeout_s) as r:
                return r.read()
        except OSError as exc:
            if attempt == retries - 1:
                raise
            log.warning("GET %s failed (%s); retrying", url, exc)
            time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def fetch_label(spec: RemoteSpec, stem: str, cache_dir: Path) -> dict:
    """The tile's PDS label, from the cache or the server (labels are a few KB)."""
    path = Path(cache_dir) / "labels" / f"{stem}_float.lbl"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        text = _get_with_retries(spec.url(stem, "lbl"))
        tmp = path.with_name(path.name + ".part")
        tmp.write_bytes(text)
        tmp.replace(path)
    return read_label(path)


def open_remote(spec: RemoteSpec, cache_dir: Path, fetcher: HttpRangeFetcher | None = None,
                label_loader=fetch_label) -> DemProduct:
    """A DemProduct whose grid is read from the PDS server on demand.

    Mosaics (several tiles) are joined into one global grid. For products
    without a fixed layout, each tile's place
    comes from its own label: row0 = (90 - MAXIMUM_LATITUDE) * ppd and
    col0 = WESTERNMOST_LONGITUDE * ppd; the global offsets then follow as
    LINE_PROJECTION_OFFSET + row0 and SAMPLE_PROJECTION_OFFSET + col0, and must
    agree for every tile (checked here) or the product is refused.
    """
    if spec.stems == SLDEM_512_STEMS and spec.base == SLDEM_TILES_BASE:
        return _open_sldem2015(spec, cache_dir, fetcher)

    tiles, global_proj, km_scale, pixel_size_m = [], None, None, None
    # Labels are a few KB each; fetch a mosaic's (up to 32) in parallel the first time.
    with ThreadPoolExecutor(max_workers=LABEL_WORKERS) as pool:
        labels = list(pool.map(lambda stem: label_loader(spec, stem, cache_dir), spec.stems))
    for stem, label in zip(spec.stems, labels):
        image = find_object(label, "IMAGE")
        proj = find_object(label, "IMAGE_MAP_PROJECTION")
        _check_image_format(image, Path(f"{stem}.lbl"))
        lines, samples = int(image["LINES"]), int(image["LINE_SAMPLES"])
        projection, pixel_size_m = _build_projection(proj, lines, samples)
        scale = float(image.get("SCALING_FACTOR", 1.0))
        if km_scale is not None and scale != km_scale:
            raise ValueError(f"{spec.name}: tiles disagree on SCALING_FACTOR")
        km_scale = scale
        if len(spec.stems) == 1:
            tiles.append(Tile(spec.url(stem, "img"), 0, 0, lines, samples))
            global_proj = projection
            continue
        ppd = projection.pixels_per_degree
        row0 = round((90.0 - float(proj["MAXIMUM_LATITUDE"])) * ppd)
        col0 = round(float(proj["WESTERNMOST_LONGITUDE"]) * ppd)
        candidate = SimpleCylindrical(
            lines=round(180 * ppd), samples=round(360 * ppd), pixels_per_degree=ppd,
            center_lat=projection.center_lat, center_lon=projection.center_lon,
            line_offset=projection.line_offset + row0, sample_offset=projection.sample_offset + col0,
            west_lon=0.0, east_lon=360.0,
        )
        if global_proj is not None and candidate != global_proj:
            raise ValueError(f"{spec.name}: tile {stem} does not fit the mosaic ({candidate} vs {global_proj})")
        global_proj = candidate
        tiles.append(Tile(spec.url(stem, "img"), row0, col0, lines, samples))
    if isinstance(global_proj, SimpleCylindrical):
        lines, samples = global_proj.lines, global_proj.samples
    else:
        lines = samples = global_proj.size
    # Rows that actually hold data (a latitude-limited mosaic leaves the rest empty).
    first = min(t.row0 for t in tiles)
    last = max(t.row0 + t.lines for t in tiles) - 1
    valid = None if (first, last) == (0, lines - 1) else (first, last)
    grid = RemoteGrid(spec.name, lines, samples, tiles, Path(cache_dir) / "blocks", fetcher)
    return DemProduct(name=spec.name, projection=global_proj, data=grid,
                      pixel_size_m=pixel_size_m, km_scale=km_scale, valid_lines=valid)


def _open_sldem2015(spec: RemoteSpec, cache_dir: Path, fetcher: HttpRangeFetcher | None) -> DemProduct:
    """Use the fixed layout of the archived 512 px/degree float image release.

    The PDS labels specify identical 30° × 45° pixel-registered tiles with
    unit scale in kilometres. The layout was checked against all 32 labels.
    Opening a site therefore needs no label requests for unrelated tiles.
    """
    ppd = 512
    lines, samples = 180 * ppd, 360 * ppd
    tile_lines, tile_samples = 30 * ppd, 45 * ppd
    first_row = 30 * ppd  # mosaic starts at 60°N in the global grid
    tiles = []
    for index, stem in enumerate(spec.stems):
        row, col = divmod(index, len(_LON_SLDEM))
        tiles.append(Tile(spec.url(stem, "img"), first_row + row * tile_lines, col * tile_samples,
                          tile_lines, tile_samples))
    projection = SimpleCylindrical(
        lines=lines, samples=samples, pixels_per_degree=ppd, center_lat=0.0, center_lon=180.0,
        line_offset=lines / 2 - 0.5, sample_offset=samples / 2 - 0.5, west_lon=0.0, east_lon=360.0,
    )
    grid = RemoteGrid(spec.name, lines, samples, tiles, Path(cache_dir) / "blocks", fetcher)
    return DemProduct(name=spec.name, projection=projection, data=grid,
                      pixel_size_m=59.2252938, km_scale=1.0,
                      valid_lines=(first_row, lines - first_row - 1))


class LazyRemoteProduct:
    """Stands in for a remote DemProduct and opens it (fetching labels) only when
    a point inside its nominal coverage is actually looked up. So listing every
    product costs no network traffic."""

    is_remote = True

    def __init__(self, spec: RemoteSpec, cache_dir: Path, fetcher: HttpRangeFetcher | None = None,
                 label_loader=fetch_label):
        self.spec = spec
        self.name = spec.name
        self.pixel_size_m = spec.pixel_size_m
        self._cache_dir = cache_dir
        self._fetcher = fetcher
        self._label_loader = label_loader
        self._product: DemProduct | None = None
        self._lock = threading.Lock()

    @property
    def product(self) -> DemProduct:
        with self._lock:
            if self._product is None:
                self._product = open_remote(self.spec, self._cache_dir, self._fetcher, self._label_loader)
                self.pixel_size_m = self._product.pixel_size_m
            return self._product

    def _nominal(self, lat):
        lat = np.asarray(lat, dtype=float)
        if self.spec.south is None:
            return np.abs(lat) <= self.spec.max_abs_lat
        hemi = lat < 0 if self.spec.south else lat > 0
        return hemi & (np.abs(lat) >= self.spec.min_abs_lat)

    def contains(self, lat, lon):
        near = self._nominal(lat)
        if not near.any():
            return near
        return near & self.product.contains(lat, lon)

    def heights_m(self, lat, lon, method: str = "bilinear"):
        lat, lon = np.atleast_1d(np.asarray(lat, dtype=float)), np.atleast_1d(np.asarray(lon, dtype=float))
        out = np.full(lat.shape, np.nan)
        near = self._nominal(lat)
        if near.any():
            out[near] = self.product.heights_m(lat[near], lon[near], method)
        return out

    def height_m(self, lat: float, lon: float, method: str = "bilinear") -> float:
        return float(self.heights_m(lat, lon, method)[0])

    def __getattr__(self, attr):  # projection, data, shape, ... from the opened product
        if attr.startswith("_"):
            raise AttributeError(attr)
        return getattr(self.product, attr)


# Non-polar maps used by default (team decision 2026-11-15): SLDEM2015 at 512
# px/deg (59.2 m, LOLA + Kaguya stereo, |lat| <= 60) for the landing site itself,
# and ldem_128 (237 m, LOLA, whole Moon) for everything farther out. The others
# (ldem_512, ldem_256, ldem_64) stay available through remote_specs() but are
# not loaded, so no spacing ever picks them.
DEFAULT_GLOBAL = ("sldem2015_512", "ldem_128")


def load_remote(cache_dir: Path, fetcher: HttpRangeFetcher | None = None,
                global_names: tuple[str, ...] = DEFAULT_GLOBAL) -> list[LazyRemoteProduct]:
    """Every remote polar LOLA product plus the chosen global ones, unopened."""
    specs = [s for s in remote_specs() if s.folder == "polar" or s.name in global_names]
    return [LazyRemoteProduct(spec, cache_dir, fetcher) for spec in specs]

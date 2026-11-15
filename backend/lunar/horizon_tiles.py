"""Horizon maps shared between nearby sites: a fixed lattice of points, computed
in tiles, cached in memory and on disk, and precomputed around visited sites.

Why: a user moves between sites a few kilometres apart. A site-centred grid
recomputes every point for every new coordinate; on a fixed lattice the points a
new site needs are mostly already computed.

Lattice
-------
* Frame: the azimuthal-equidistant plane of an anchor point. Anchors sit on a
  100 km lattice (polar azimuthal-equidistant x, y within 10 deg of a pole;
  latitude/longitude elsewhere), so every site within ~70 km of an anchor uses
  the same frame. Within 100 km of the anchor, distances between points in the
  plane are true to (rho/R)^2 / 6 < 6e-4 (the near rays use them; the disc test
  and the illumination use each point's exact latitude and longitude).
* Spacing: from the ladder 50 * sqrt(2)^k m, the value nearest D/64 (about
  64-90 points across any site from 5 to 50 km).
* Tiles of TILE x TILE nodes; node (i, j) is at x = i s, y = j s in the frame.

Each node's horizon map is computed exactly as lunar.horizon_maps.compute_block
does it (far sub-grid every 8 nodes, aligned to the lattice, so a node's value
does not depend on which block computed it).
"""

from __future__ import annotations

import hashlib
import logging
import math
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .config import MOON_RADIUS_M as R
from .geometry import destination, dot, unit_up
from .horizon_maps import (DEFAULT_AZIMUTH_STEP_DEG, NEAR_TARGET_M, _grid_coords, compute_block, map_surfaces)

log = logging.getLogger(__name__)

FRAME_CELL_M = 100_000.0
TILE = 16  # nodes per tile side
SUB_STEP = 8  # far sub-grid every 8 nodes (divides TILE)
PREFETCH_TILES = 3  # tiles precomputed around a visited site, each side
PREFETCH_CHUNK = 4  # tiles per background computation (a request waits at most one chunk)
MEMORY_TILES = 1500  # in-memory LRU (one tile at 1 deg = 16*16*360 float32 = 0.37 MB)
VERSION = "v2"  # bump when the per-node computation changes (v2: spike correction)


def spacing_for(diameter_m: float) -> float:
    """Ladder value 50 * sqrt(2)^k nearest (in ratio) to D / 64."""
    k = round(2 * math.log2(max(diameter_m / 64, 1.0) / 50.0))
    return 50.0 * math.sqrt(2) ** max(k, 0)


def near_radius_for(spacing: float) -> float:
    return max(5_000.0, 8 * SUB_STEP * spacing)


def anchor_for(lat: float, lon: float) -> tuple[float, float]:
    """Frame anchor for a site: the nearest point of a 100 km lattice."""
    cell_deg = math.degrees(FRAME_CELL_M / R)
    if abs(lat) >= 80.0:
        sign = 1.0 if lat > 0 else -1.0
        rho = R * math.radians(90.0 - abs(lat))
        x, y = rho * math.sin(math.radians(lon)), rho * math.cos(math.radians(lon))
        x, y = round(x / FRAME_CELL_M) * FRAME_CELL_M, round(y / FRAME_CELL_M) * FRAME_CELL_M
        rho = math.hypot(x, y)
        lon_a = math.degrees(math.atan2(x, y)) % 360.0 if rho > 0 else 0.0
        return sign * (90.0 - math.degrees(rho / R)), lon_a
    lat_a = round(lat / cell_deg) * cell_deg
    lon_step = cell_deg / max(math.cos(math.radians(lat_a)), 1e-6)
    return lat_a, (round((lon % 360.0) / lon_step) * lon_step) % 360.0


@dataclass
class SiteHorizon:
    """Horizon maps for the lattice nodes covering one site disc."""
    lat: float
    lon: float
    diameter_m: float
    mast_height_m: float
    anchor: tuple[float, float]
    spacing_m: float
    i0: int  # lattice index of column 0 (x = i0 s in the frame)
    j0: int  # lattice index of row 0
    point_lat: np.ndarray  # (ny, nx)
    point_lon: np.ndarray
    ground_m: np.ndarray
    gamma_deg: np.ndarray
    azimuth_deg: np.ndarray
    horizon_deg: np.ndarray  # (ny, nx, A) float32
    in_disc: np.ndarray  # (ny, nx): surface distance from the site centre <= D/2
    site_xy_m: np.ndarray  # (ny, nx, 2): each node in the SITE's frame (x east, y north)
    affine: np.ndarray  # (2, 3): frame (x, y) = A[:, :2] @ site (x, y) + A[:, 2]
    affine_residual_m: float
    stats: dict = field(default_factory=dict)


class HorizonTiles:
    def __init__(self, products, cache_dir: Path | None):
        self.products = products
        self.cache_dir = Path(cache_dir) / "horizons" / VERSION if cache_dir else None
        self._memory: OrderedDict = OrderedDict()
        self._lock = threading.Lock()  # memory cache
        self._compute = threading.Lock()  # one block computation at a time
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="horizon-prefetch")
        self._queued: set = set()
        self._waiting = 0  # requests waiting to compute tiles
        self._waiting_lock = threading.Lock()
        self.stats = {"computed_tiles": 0, "disk_tiles": 0, "memory_tiles": 0}  # totals since start

    # ----- public -----

    def site(self, lat: float, lon: float, diameter_m: float, mast_height_m: float, prefetch: bool = True) -> SiteHorizon:
        anchor = anchor_for(lat, lon)
        s = spacing_for(diameter_m)
        xc, yc = (float(v[0]) for v in _grid_coords(anchor[0], anchor[1], np.array([lat]), np.array([lon])))
        r = diameter_m / 2 + 1.5 * s
        i0, i1 = math.floor((xc - r) / s), math.ceil((xc + r) / s)
        j0, j1 = math.floor((yc - r) / s), math.ceil((yc + r) / s)
        # Tiles whose nodes come within r of the site centre (skip the bounding box's corners).
        def touches(ti, tj):
            dx = max(ti * TILE * s - xc, 0.0, xc - (ti * TILE + TILE - 1) * s)
            dy = max(tj * TILE * s - yc, 0.0, yc - (tj * TILE + TILE - 1) * s)
            return math.hypot(dx, dy) <= r
        tiles = [(ti, tj) for tj in range(j0 // TILE, j1 // TILE + 1) for ti in range(i0 // TILE, i1 // TILE + 1)
                 if touches(ti, tj)]
        got, computed = self._tiles(anchor, s, mast_height_m, tiles)
        stats = {"tiles": len(tiles), "computed": computed, "reused": len(tiles) - computed}

        def take(name, dtype=None):
            sample = next(iter(got.values()))[name]
            out = np.full((j1 - j0 + 1, i1 - i0 + 1) + sample.shape[2:], np.nan, dtype=dtype or sample.dtype)
            for (ti, tj), tile in got.items():
                # Overlap of this tile's nodes with the site's node window.
                a0, a1 = max(ti * TILE, i0), min(ti * TILE + TILE - 1, i1)
                b0, b1 = max(tj * TILE, j0), min(tj * TILE + TILE - 1, j1)
                if a0 > a1 or b0 > b1:
                    continue
                out[b0 - j0:b1 - j0 + 1, a0 - i0:a1 - i0 + 1] = \
                    tile[name][b0 - tj * TILE:b1 - tj * TILE + 1, a0 - ti * TILE:a1 - ti * TILE + 1]
            return out
        site = SiteHorizon(
            lat=lat, lon=lon, diameter_m=diameter_m, mast_height_m=mast_height_m, anchor=anchor, spacing_m=s,
            i0=i0, j0=j0, point_lat=take("lat"), point_lon=take("lon"), ground_m=take("ground_m"),
            gamma_deg=take("gamma_deg"), azimuth_deg=np.arange(0.0, 360.0, DEFAULT_AZIMUTH_STEP_DEG),
            horizon_deg=take("horizon_deg", np.float32), in_disc=None, site_xy_m=None, affine=None,
            affine_residual_m=0.0, stats=stats,
        )
        # Disc and site-frame coordinates from each node's exact latitude/longitude.
        up0 = unit_up(lat, lon)
        u = unit_up(site.point_lat, site.point_lon)
        with np.errstate(invalid="ignore"):
            site.in_disc = R * np.arccos(np.clip(dot(u, up0), -1, 1)) <= diameter_m / 2 + 1e-6
        sx, sy = _grid_coords(lat, lon, site.point_lat, site.point_lon)
        site.site_xy_m = np.stack([sx, sy], axis=-1)
        site.affine, site.affine_residual_m = _fit_affine(lat, lon, anchor, diameter_m)
        if prefetch:
            self._prefetch(anchor, s, mast_height_m, i0, i1, j0, j1)
        return site

    # ----- tiles -----

    def _tiles(self, anchor, s, mast, tiles):
        """Tiles by index, and how many of them this call computed."""
        out, missing = {}, []
        for t in tiles:
            tile = self._get(anchor, s, mast, t)
            if tile is None:
                missing.append(t)
            else:
                out[t] = tile
        if missing:
            with self._waiting_lock:
                self._waiting += 1  # the prefetcher pauses between chunks while > 0
            try:
                self._compute.acquire()
            finally:
                with self._waiting_lock:
                    self._waiting -= 1
            try:
                # Another thread (the prefetcher) may have finished some meanwhile.
                still = []
                for t in missing:
                    tile = self._get(anchor, s, mast, t)
                    if tile is None:
                        still.append(t)
                    else:
                        out[t] = tile
                for group in _groups(still):
                    out.update(self._compute_tiles(anchor, s, mast, group))
                return out, len(still)
            finally:
                self._compute.release()
        return out, 0

    def _compute_tiles(self, anchor, s, mast, tiles):
        ti0 = min(t[0] for t in tiles)
        ti1 = max(t[0] for t in tiles)
        tj0 = min(t[1] for t in tiles)
        tj1 = max(t[1] for t in tiles)
        nx, ny = (ti1 - ti0 + 1) * TILE + 1, (tj1 - tj0 + 1) * TILE + 1  # +1: the far sub-grid's closing node
        near_spacing = s / max(1, math.ceil(s / NEAR_TARGET_M))
        near, far = map_surfaces(self.products, near_spacing)
        block = compute_block(near, far, anchor[0], anchor[1], ti0 * TILE * s, tj0 * TILE * s, nx, ny, s,
                              mast_height_m=mast, sub_step=SUB_STEP, near_radius_m=near_radius_for(s))
        out = {}
        for tj in range(tj0, tj1 + 1):
            for ti in range(ti0, ti1 + 1):
                c, r = (ti - ti0) * TILE, (tj - tj0) * TILE
                tile = {name: np.ascontiguousarray(block[name][r:r + TILE, c:c + TILE])
                        for name in ("lat", "lon", "ground_m", "gamma_deg", "horizon_deg")}
                self._put(anchor, s, mast, (ti, tj), tile)
                out[(ti, tj)] = tile
        self.stats["computed_tiles"] += len(out)
        return {t: out[t] for t in tiles}

    def _key(self, anchor, s, mast, t):
        return (round(anchor[0], 6), round(anchor[1], 6), round(s, 3), round(mast, 3), t)

    def _path(self, key):
        frame = hashlib.sha1(repr(key[:4]).encode()).hexdigest()[:16]
        return self.cache_dir / frame / f"{key[4][0]}_{key[4][1]}.npz"

    def _get(self, anchor, s, mast, t):
        key = self._key(anchor, s, mast, t)
        with self._lock:
            tile = self._memory.get(key)
            if tile is not None:
                self._memory.move_to_end(key)
                self.stats["memory_tiles"] += 1
                return tile
        if self.cache_dir is None:
            return None
        path = self._path(key)
        if not path.exists():
            return None
        try:
            with np.load(path) as z:
                tile = {name: z[name] for name in z.files}
            tile["horizon_deg"] = tile["horizon_deg"].astype(np.float32)
        except (OSError, ValueError):
            return None
        self._remember(key, tile)
        self.stats["disk_tiles"] += 1
        return tile

    def _put(self, anchor, s, mast, t, tile):
        key = self._key(anchor, s, mast, t)
        self._remember(key, tile)
        if self.cache_dir is None:
            return
        path = self._path(key)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp.npz")
            # Horizon as float16 on disk: 0.002-0.03 deg steps over 1-90 deg, far finer than the map.
            np.savez(tmp, **{**tile, "horizon_deg": tile["horizon_deg"].astype(np.float16)})
            tmp.replace(path)
        except OSError as exc:  # a full or read-only disk only loses the cache
            log.warning("horizon tile not cached: %s", exc)

    def _remember(self, key, tile):
        with self._lock:
            self._memory[key] = tile
            self._memory.move_to_end(key)
            while len(self._memory) > MEMORY_TILES:
                self._memory.popitem(last=False)

    # ----- precomputing around a visited site -----

    def _prefetch(self, anchor, s, mast, i0, i1, j0, j1):
        """Queue the tiles within PREFETCH_TILES of the site, nearest first, in
        chunks of PREFETCH_CHUNK tiles. Requests take priority: the prefetcher
        waits between chunks while a request is waiting to compute."""
        tj_lo, tj_hi = j0 // TILE - PREFETCH_TILES, j1 // TILE + PREFETCH_TILES
        ti_lo, ti_hi = i0 // TILE - PREFETCH_TILES, i1 // TILE + PREFETCH_TILES
        cj, ci = (j0 + j1) / 2 / TILE, (i0 + i1) / 2 / TILE
        frame = self._key(anchor, s, mast, (0, 0))[:4]
        wanted = sorted(((ti, tj) for tj in range(tj_lo, tj_hi + 1) for ti in range(ti_lo, ti_hi + 1)),
                        key=lambda t: (t[0] - ci) ** 2 + (t[1] - cj) ** 2)
        for start in range(0, len(wanted), PREFETCH_CHUNK):
            chunk = tuple(wanted[start:start + PREFETCH_CHUNK])
            job = (frame, chunk)
            if job in self._queued:
                continue
            self._queued.add(job)
            try:
                self._pool.submit(self._prefetch_chunk, anchor, s, mast, chunk, job)
            except RuntimeError:  # interpreter shutting down
                self._queued.discard(job)
                return

    def _prefetch_chunk(self, anchor, s, mast, chunk, job):
        try:
            todo = [t for t in chunk if self._get(anchor, s, mast, t) is None]
            if not todo:
                return
            while self._waiting:
                time.sleep(0.05)
            self._tiles(anchor, s, mast, todo)
        except RuntimeError:  # interpreter shutting down
            pass
        except Exception as exc:  # background work must never take the server down
            log.warning("horizon prefetch failed: %s", exc)
        finally:
            self._queued.discard(job)


def _groups(tiles):
    """Split tiles into blocks worth computing together: one bounding box if it
    holds at most twice the tiles needed, else runs of adjacent tiles per row
    (a block has a fixed cost, so scattered tiles should not pull in their
    whole bounding box)."""
    if not tiles:
        return []
    ti = [t[0] for t in tiles]
    tj = [t[1] for t in tiles]
    if (max(ti) - min(ti) + 1) * (max(tj) - min(tj) + 1) <= 2 * len(tiles):
        return [tiles]
    runs = []
    for row in sorted(set(tj)):
        cols = sorted(t[0] for t in tiles if t[1] == row)
        start = prev = cols[0]
        for c in cols[1:] + [None]:
            if c is not None and c == prev + 1:
                prev = c
                continue
            runs.append([(x, row) for x in range(start, prev + 1)])
            if c is not None:
                start = prev = c
    return runs


def _fit_affine(lat, lon, anchor, diameter_m):
    """Least-squares map from the site's azimuthal-equidistant plane to the
    frame's, fitted on points across the site disc. Returns (A (2, 3), max
    residual in metres)."""
    r = np.linspace(0.0, diameter_m / 2 * 1.05, 6)
    az = np.arange(0.0, 360.0, 30.0)
    rr, aa = np.meshgrid(r, az)
    sx, sy = rr * np.sin(np.radians(aa)), rr * np.cos(np.radians(aa))
    plat, plon = destination(lat, lon, aa, rr)
    fx, fy = _grid_coords(anchor[0], anchor[1], plat, plon)
    design = np.column_stack([sx.ravel(), sy.ravel(), np.ones(sx.size)])
    coef_x, *_ = np.linalg.lstsq(design, fx.ravel(), rcond=None)
    coef_y, *_ = np.linalg.lstsq(design, fy.ravel(), rcond=None)
    resid = np.hypot(design @ coef_x - fx.ravel(), design @ coef_y - fy.ravel()).max()
    return np.vstack([coef_x, coef_y]), float(resid)

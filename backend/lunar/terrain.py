"""Site terrain package: a site mesh with an optional far mesh and skyline
(step 2 of docs/terrain_shadows_plan.md).

1. Site grid: a square, regular grid over the landing-site disc (diameter D)
   plus one cell, on an AZIMUTHAL EQUIDISTANT layout centred on the site:
       x = metres east, y = metres north, measured ALONG THE SURFACE, so
       azimuth = atan2(x, y)  and  surface distance = sqrt(x^2 + y^2).
   Each (x, y) maps to (lat, lon) exactly with geometry.destination (a great
   circle), then takes its height from the elevation map.
   Spacing s = max(D / points_across, pixel size of the map chosen at the
   site): never finer than the data. Heights use target spacing s, so the
   finest suitable map is used (SLDEM2015 below 60 deg, polar maps above).

2. Optional far mesh: an observer-centred radial mesh. Azimuths every azimuth_step_deg
   and ring distances from the site radius D/2 out to max_range_m, with
       step(d) = max(s, relative_step * d)
   Heights use target spacing FAR_TARGET_M = 240 m, which picks ldem_128
   (2 pi R / (360 * 128) = 236.9 m) below 60 deg and the 240 m polar maps
   near the poles (team decision: fine map for the site only).

Every vertex is a true 3-D position, so the Moon's curvature is built in:
    P = (R + h) * U(lat, lon)               R = 1737.4 km, U = unit up
    rho = P - O                             O = eye = (R + ground + eye_height) * U(site)
    (e, n, u) = (rho . E, rho . N, rho . U) the site's East/North/Up frame
Over a smooth sphere a point at surface distance d therefore sits at
    u = R cos(d/R) - (R + eye)   (about -d^2 / 2R: -5.17 km at 134 km)
    horizontal distance = R sin(d/R).
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

import numpy as np

from .config import MOON_RADIUS_M
from .dem import best_product, heights_at
from .geometry import destination, dot, enu_basis, look_angles, surface_vector
from .horizon import DEFAULT_RELATIVE_STEP, sample_distances
from .foreground import FOREGROUND_BLEND_M, ForegroundSurface
from .lola_chain import LolaChain
from .panorama import render_panorama

DEFAULT_POINTS_ACROSS = 400
DEFAULT_FAR_AZIMUTH_STEP_DEG = 0.5
DEFAULT_FAR_RELATIVE_STEP = 0.01
DEFAULT_MAX_RANGE_M = 300_000.0  # as lunar.horizon
FAR_TARGET_M = 240.0  # far-field map spacing: ldem_128 (236.9 m) or 240 m polar maps


@dataclass
class SiteTerrain:
    lat: float
    lon: float
    diameter_m: float
    eye_height_m: float
    ground_m: float  # terrain height at the site centre, above the 1737.4 km sphere
    site_map: str  # map chosen for the site grid
    spacing_m: float  # site grid spacing s
    site_xy_m: np.ndarray  # (n,) grid coordinates, same for x (east) and y (north)
    site_enu: np.ndarray  # (n, n, 3) float64, rows = y (north) from -hw to +hw, cols = x
    site_height_m: np.ndarray  # (n, n)
    site_pixel_m: np.ndarray  # (n, n) pixel size of the map each height came from
    far_azimuth_deg: np.ndarray  # (A,)
    far_distance_m: np.ndarray  # (D,)
    far_enu: np.ndarray  # (A, D, 3)
    far_height_m: np.ndarray  # (A, D)
    far_pixel_m: np.ndarray  # (A, D)
    timings_s: dict = field(default_factory=dict)
    # Reference skyline ray-cast from the same maps (ray_skyline), or None.
    ray_skyline_deg: np.ndarray | None = None  # (A,) at far_azimuth_deg
    ray_skyline_distance_m: np.ndarray | None = None  # (A,)
    panorama_shade: np.ndarray | None = None  # (elevation rows, azimuth columns)
    foreground_map: str | None = None
    foreground_pixel_m: float | None = None
    elevation_maps: list[str] | None = None

    @property
    def eye_m(self) -> float:
        return self.ground_m + self.eye_height_m

    def in_disc(self) -> np.ndarray:
        """(n, n) True where the grid point lies within the site disc (surface distance <= D/2)."""
        x = self.site_xy_m
        return np.hypot(x[None, :], x[:, None]) <= self.diameter_m / 2


def site_grid_xy(diameter_m: float, spacing_m: float) -> np.ndarray:
    """Grid coordinates covering the disc plus one cell: 0, +/-s, +/-2s, ... (odd count,
    so the site centre is a vertex)."""
    half = math.ceil((diameter_m / 2 + spacing_m) / spacing_m)
    return np.arange(-half, half + 1) * spacing_m


def ring_distances(start_m: float, max_range_m: float, min_step_m: float, relative_step: float) -> np.ndarray:
    """start, then d += max(min_step, relative_step * d) up to max_range (included)."""
    d, out = start_m, []
    while d < max_range_m:
        out.append(d)
        d += max(min_step_m, relative_step * d)
    out.append(max_range_m)
    return np.asarray(out)


def to_enu(lat, lon, height_m, eye_position, basis) -> np.ndarray:
    """(..., 3) East/North/Up metres of terrain points relative to the eye."""
    rho = surface_vector(lat, lon, height_m) - eye_position
    east, north, up = basis
    return np.stack([dot(rho, east), dot(rho, north), dot(rho, up)], axis=-1)


def build_site_terrain(
    products,
    lat: float,
    lon: float,
    diameter_m: float,
    eye_height_m: float = 1.8,
    points_across: int = DEFAULT_POINTS_ACROSS,
    far_azimuth_step_deg: float = DEFAULT_FAR_AZIMUTH_STEP_DEG,
    far_relative_step: float = DEFAULT_FAR_RELATIVE_STEP,
    max_range_m: float = DEFAULT_MAX_RANGE_M,
    far_target_m: float = FAR_TARGET_M,
    with_ray_skyline: bool = False,
    with_far_mesh: bool = True,
    with_panorama: bool = False,
    with_lola_chain: bool = False,
) -> SiteTerrain:
    timings = {}
    t0 = time.perf_counter()

    # Site grid spacing: the requested density, but never finer than the map.
    target = diameter_m / points_across
    chain = LolaChain(products, lat, lon) if with_lola_chain else None
    site_map = chain.global_maps[0] if chain is not None else best_product(products, lat, lon, target_m=target)
    spacing = max(target, float(site_map.pixel_size_m))
    xy = site_grid_xy(diameter_m, spacing)
    x, y = np.meshgrid(xy, xy)  # rows: y (north), cols: x (east)
    az = np.degrees(np.arctan2(x, y))
    dist = np.hypot(x, y)
    s_lat, s_lon = destination(lat, lon, az, dist)
    if with_far_mesh:
        s_h, s_px = heights_at(products, s_lat, s_lon, target_m=spacing)
    else:
        # Include all corners of cells intersecting the disc. The corners of the
        # bounding square don't contribute triangles and need no DEM samples.
        sampled = np.hypot(np.maximum(np.abs(x) - spacing, 0),
                           np.maximum(np.abs(y) - spacing, 0)) <= diameter_m / 2
        s_h = np.full(x.shape, np.nan)
        s_px = np.full(x.shape, np.nan)
        if chain is not None:
            s_h[sampled], s_px[sampled] = chain.sample(s_lat[sampled], s_lon[sampled], az[sampled], dist[sampled])
        else:
            s_h[sampled], s_px[sampled] = heights_at(products, s_lat[sampled], s_lon[sampled], target_m=spacing)
    foreground = None
    if with_panorama:
        foreground = chain.foreground if chain is not None else ForegroundSurface(products, lat, lon)
        if chain is None and len(products) > 1:
            close = dist < FOREGROUND_BLEND_M
            s_h[close] = foreground.blend(s_h[close], x[close], y[close], dist[close])
    centre = len(xy) // 2
    ground = float(s_h[centre, centre])
    if not np.isfinite(ground):
        raise LookupError(f"no elevation map covers lat={lat}, lon={lon}")
    timings["site_heights"] = time.perf_counter() - t0

    eye_position = surface_vector(lat, lon, ground + eye_height_m)
    basis = enu_basis(lat, lon)
    site_enu = to_enu(s_lat, s_lon, s_h, eye_position, basis)

    azimuths = np.arange(0.0, 360.0, far_azimuth_step_deg)
    rings = np.empty(0)
    f_h = f_px = np.empty((len(azimuths), 0))
    far_enu = np.empty((len(azimuths), 0, 3))
    if with_far_mesh:
        t1 = time.perf_counter()
        rings = ring_distances(diameter_m / 2, max_range_m, spacing, far_relative_step)
        f_lat, f_lon = destination(lat, lon, azimuths[:, None], rings[None, :])
        f_h, f_px = heights_at(products, f_lat, f_lon, target_m=far_target_m)
        timings["far_heights"] = time.perf_counter() - t1
        far_enu = to_enu(f_lat, f_lon, f_h, eye_position, basis)

    sky_el = sky_d = panorama = None
    if with_panorama:
        t2 = time.perf_counter()
        sky_el, sky_d, panorama = render_panorama(
            products, lat, lon, azimuths, ground + eye_height_m,
            spacing, max_range_m, far_target_m, foreground, chain=chain,
        )
        timings["panorama"] = time.perf_counter() - t2
    elif with_ray_skyline:
        t2 = time.perf_counter()
        sky_el, sky_d = ray_skyline(products, lat, lon, eye_position, basis, azimuths, diameter_m / 2,
                                    spacing, max_range_m, far_target_m, batch_reads=not with_far_mesh)
        timings["ray_skyline"] = time.perf_counter() - t2
    timings["total"] = time.perf_counter() - t0

    return SiteTerrain(
        lat=lat, lon=lon, diameter_m=diameter_m, eye_height_m=eye_height_m, ground_m=ground,
        site_map=site_map.name, spacing_m=spacing, site_xy_m=xy,
        site_enu=site_enu, site_height_m=s_h, site_pixel_m=s_px,
        far_azimuth_deg=azimuths, far_distance_m=rings,
        far_enu=far_enu, far_height_m=f_h, far_pixel_m=f_px, timings_s=timings,
        ray_skyline_deg=sky_el, ray_skyline_distance_m=sky_d,
        panorama_shade=panorama,
        foreground_map=foreground.name if foreground is not None else None,
        foreground_pixel_m=float(foreground.pixel_size_m) if foreground is not None else None,
        elevation_maps=chain.maps if chain is not None else None,
    )


def ray_skyline(products, lat, lon, eye_position, basis, azimuths_deg, site_radius_m, spacing_m,
                max_range_m, far_target_m=FAR_TARGET_M, chunk=60, batch_reads=False):
    """Local horizon around the observer: the lunar.skyline method (rays,
    samples at step(d) = max(spacing / 2, 0.5 % of d), elevation from look_angles),
    reading heights from the SAME maps as the meshes: target spacing = site spacing
    within the site radius, far_target_m beyond. Any difference from the mesh
    skyline is then geometry or sampling, not data.

    Returns (elevation_deg, distance_m), one per azimuth."""
    distances = sample_distances(max_range_m, spacing_m / 2, DEFAULT_RELATIVE_STEP)
    target = np.where(distances <= site_radius_m, spacing_m, far_target_m)
    if batch_reads:
        # Group lookups from all headings so the remote reader sees adjacent
        # image blocks together. Split only large requests to bound memory.
        batch_size = max(1, 1_000_000 // len(azimuths_deg))
        el_out = np.full(len(azimuths_deg), -np.inf)
        d_out = np.full(len(azimuths_deg), np.nan)
        for start in range(0, len(distances), batch_size):
            stop = start + batch_size
            d = distances[start:stop]
            r_lat, r_lon = destination(lat, lon, azimuths_deg[:, None], d[None, :])
            heights, _ = heights_at(products, r_lat, r_lon, target_m=target[None, start:stop])
            _, elevation, _ = look_angles(eye_position, surface_vector(r_lat, r_lon, heights), basis)
            elevation = np.where(np.isfinite(elevation), elevation, -np.inf)
            best = np.argmax(elevation, axis=1)
            peak = elevation[np.arange(len(best)), best]
            improved = peak > el_out
            el_out[improved] = peak[improved]
            d_out[improved] = d[best[improved]]
        if not np.isfinite(el_out).all():
            raise LookupError("Elevation maps do not cover all skyline directions.")
        return el_out, d_out
    el_out = np.empty(len(azimuths_deg))
    d_out = np.empty(len(azimuths_deg))
    for i in range(0, len(azimuths_deg), chunk):
        az = np.asarray(azimuths_deg[i:i + chunk], dtype=float)
        r_lat, r_lon = destination(lat, lon, az[:, None], distances[None, :])
        h, _ = heights_at(products, r_lat, r_lon, target_m=np.broadcast_to(target, r_lat.shape))
        _, el, _ = look_angles(eye_position, surface_vector(r_lat, r_lon, h), basis)
        best = np.nanargmax(el, axis=1)
        rows = np.arange(len(az))
        el_out[i:i + chunk] = el[rows, best]
        d_out[i:i + chunk] = distances[best]
    return el_out, d_out


def elevation_deg(enu: np.ndarray) -> np.ndarray:
    """Apparent elevation of ENU points from the eye: atan2(u, sqrt(e^2 + n^2))."""
    return np.degrees(np.arctan2(enu[..., 2], np.hypot(enu[..., 0], enu[..., 1])))


def far_mesh_skyline(terrain: SiteTerrain) -> np.ndarray:
    """Highest apparent elevation along each far-mesh azimuth: the mesh's own skyline,
    for checking against lunar.skyline (the reference)."""
    return np.nanmax(elevation_deg(terrain.far_enu), axis=1)


def maps_used(pixel_m: np.ndarray) -> dict[str, int]:
    """How many vertices took their height from each map resolution."""
    values, counts = np.unique(np.round(pixel_m[np.isfinite(pixel_m)], 2), return_counts=True)
    return {f"{v:g} m": int(c) for v, c in zip(values, counts)}

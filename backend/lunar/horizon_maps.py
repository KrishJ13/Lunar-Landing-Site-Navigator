"""Horizon maps for a landing site: for every point of a coarse "power grid"
over the site disc, the terrain's elevation angle in every direction
(step 3 of docs/terrain_shadows_plan.md). Computed once per site, independent of
time; illumination at any instant is then a lookup (lunar.illumination).

This is the method of the LOLA polar illumination studies (Mazarico et al. 2011,
Icarus 211) and of solar GIS tools (GRASS r.horizon / r.sun, PVGIS): horizon
angles per point and direction, then the Sun's position against them.

Geometry (exact on the sphere, each point in its own frame)
----------------------------------------------------------
Observer P at height h_P (ground + mast height), terrain Q at surface distance
d along a great circle, central angle theta = d / R:
    horizontal = (R + h_Q) sin(theta),   up = (R + h_Q) cos(theta) - (R + h_P),
    elevation  = atan2(up, horizontal).
H(P, a) = max over d of elevation, the up direction being P's own vertical.

Directions are GRID azimuths (clockwise from the site grid's +y axis, the site's
north). At P, true north points at grid azimuth gamma(P) (meridian convergence:
up to tens of degrees near a pole), so true bearing b <-> grid azimuth b + gamma.

Two parts, H = max(H_near, H_far)
---------------------------------
* Near (d <= near_radius + g sqrt 2): heights on a regular "near grid" in the
  site's azimuthal-equidistant plane, with the power grid on its nodes (every
  k-th node). For one (direction, distance) the offset to Q is the same for every
  P, so a bilinear sample for all P is four strided slices of the near grid.
  In this plane, distances between points within 35 km of the site centre are
  true to (rho/R)^2 / 6 < 7e-5.
* Far (d >= near_radius): exact rays (geodesic destination, 0.5 % relative steps
  to max_range, as lunar.horizon) from a sparse sub-grid of spacing g, keeping
  the angle H_G and distance D_G of the highest point. At P, bilinear in the
  sub-grid with a height correction per corner:
      H_far(P) = sum_k w_k (H_k + (h_k - h_P) / D_k)
  (small angles; the max lies >= near_radius away). Directions, frame tilt and
  parallax vary linearly across a sub-grid cell, which bilinear interpolation
  reproduces; the height term does not, hence the correction.
"""

from __future__ import annotations

import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import numpy as np

from .config import MOON_RADIUS_M as R
from .dem import heights_at
from .dem.window import windowed
from .despike import despike
from .geometry import destination, dot, enu_basis, unit_up
from .horizon import DEFAULT_RELATIVE_STEP

DEFAULT_POINTS_ACROSS = 65  # odd: the site centre is a grid node
DEFAULT_AZIMUTH_STEP_DEG = 1.0
DEFAULT_MAST_HEIGHT_M = 2.0
NEAR_TARGET_M = 60.0  # near-grid spacing target: the ~59 m maps (ldem_512 / SLDEM2015)
FAR_MIN_STEP_M = 240.0  # far rays: the ldem_128 cell (236.9 m)
FAR_WORKERS = min(8, os.cpu_count() or 1)  # threads for the far rays (numpy releases the GIL)


@dataclass
class HorizonMaps:
    lat: float
    lon: float
    diameter_m: float
    mast_height_m: float
    spacing_m: float  # power grid spacing
    xy_m: np.ndarray  # (n,) grid coordinates, x east and y north along the surface
    in_disc: np.ndarray  # (n, n) bool
    point_lat: np.ndarray  # (n, n)
    point_lon: np.ndarray
    ground_m: np.ndarray  # (n, n) terrain height above the 1737.4 km sphere
    gamma_deg: np.ndarray  # (n, n) grid azimuth of true north at each point
    azimuth_deg: np.ndarray  # (A,) grid azimuths
    horizon_deg: np.ndarray  # (n, n, A) float32; NaN outside the disc
    params: dict = field(default_factory=dict)
    timings_s: dict = field(default_factory=dict)


def _grid_coords(lat0, lon0, lat, lon):
    """Site azimuthal-equidistant coordinates (x east, y north, metres) of points."""
    east, north, up = enu_basis(lat0, lon0)
    u = unit_up(lat, lon)
    rho = R * np.arccos(np.clip(dot(u, up), -1.0, 1.0))
    bearing = np.arctan2(dot(u, east), dot(u, north))
    return rho * np.sin(bearing), rho * np.cos(bearing)


def _to_latlon(lat0, lon0, x, y):
    return destination(lat0, lon0, np.degrees(np.arctan2(x, y)), np.hypot(x, y))


def _elevation(h_q, h_p, d):
    theta = d / R
    return np.arctan2((R + h_q) * np.cos(theta) - (R + h_p), (R + h_q) * np.sin(theta))


def _fast_surface(products, target_m):
    """surface(lat, lon) equal to heights_at(products, lat, lon, target_m=target_m)[0],
    but reading the preferred covering map directly. heights_at fills each point
    from the first map, in its preference order, that covers it; this asks that
    map first for the whole batch and passes only its gaps to heights_at."""
    order = [p for p in sorted(products, key=lambda p: (-p.pixel_size_m, bool(getattr(p, "is_remote", False))))
             if p.pixel_size_m <= target_m]
    order += _preference_after(products, order)

    loaded = {}  # product id -> windowed copy (see preload)

    def surface(qlat, qlon):
        qlat, qlon = np.broadcast_arrays(np.asarray(qlat, float), np.asarray(qlon, float))
        mid = qlat.size // 2
        first = next((p for p in order if bool(p.contains(qlat.flat[mid], qlon.flat[mid]))), None)
        if first is None:
            return heights_at(products, qlat, qlon, target_m=target_m)[0]
        h = np.asarray(loaded.get(id(first), first).heights_m(qlat, qlon), float)
        # Points the first map does not cover, or that an earlier map in the
        # order would have filled: take heights_at's answer.
        ahead = order[:order.index(first)]
        redo = ~np.isfinite(h)
        for p in ahead:
            redo |= np.asarray(p.contains(qlat, qlon), bool)
        if redo.any():
            h[redo] = heights_at(products, qlat[redo], qlon[redo], target_m=target_m)[0]
        return h

    def preload(qlat, qlon):
        """Hold in memory the pixels of the preferred map covering points (qlat, qlon),
        spike-corrected at the map's own resolution (lunar.despike)."""
        qlat, qlon = np.asarray(qlat, float), np.asarray(qlon, float)
        mid = qlat.size // 2
        first = next((p for p in order if bool(p.contains(qlat.flat[mid], qlon.flat[mid]))), None)
        if first is not None:
            loaded[id(first)] = windowed(first, qlat, qlon, despike_window=True)

    def cell_m(qlat, qlon):
        """Pixel size of the map this surface reads at (qlat, qlon)."""
        first = next((p for p in order if bool(p.contains(qlat, qlon))), None)
        return float(first.pixel_size_m) if first is not None else float(target_m)

    surface.preload = preload
    surface.cell_m = cell_m
    return surface


def _preference_after(products, chosen):
    from .dem.catalog import _preference
    return [p for p in _preference(products) if p not in chosen]


def map_surfaces(products, near_spacing_m):
    """(near, far) surface functions: the finest map no coarser than the near-grid
    spacing (polar 20-40 m maps near the poles, ~59 m below 60 deg), and the
    240 m-class maps for far rays (ldem_128 or the polar 240 m maps), as in
    docs/terrain_shadows_plan.md section 2. Both return exactly what
    heights_at(products, ..., target_m) returns. The cylindrical ldem_512 grid is
    not used near the poles: it carries isolated spikes there (e.g. +130 m in one
    sample at the connecting ridge)."""
    return _fast_surface(products, near_spacing_m), _fast_surface(products, FAR_MIN_STEP_M)


def compute_block(near_surface, far_surface, lat0, lon0, x0, y0, nx, ny, spacing, *,
                  mast_height_m=DEFAULT_MAST_HEIGHT_M, azimuth_step_deg=DEFAULT_AZIMUTH_STEP_DEG,
                  max_range_m=300_000.0, near_target_m=NEAR_TARGET_M, sub_step=8, near_radius_m=None,
                  far_workers=FAR_WORKERS):
    """Horizon maps for the nodes x = x0 + i s, y = y0 + j s (i < nx, j < ny) of the
    azimuthal-equidistant plane centred on (lat0, lon0). Far rays start from
    every sub_step-th node (and the last); near rays reach near_radius + g sqrt 2,
    g = sub_step s, near_radius defaulting to max(5 km, 8 g).
    Returns a dict of (ny, nx) arrays lat, lon, ground_m, gamma_deg and
    horizon_deg (ny, nx, A) float32, with params and timings_s."""
    t0 = time.perf_counter()
    timings = {}
    xs = x0 + np.arange(nx) * spacing
    ys = y0 + np.arange(ny) * spacing
    x, y = np.meshgrid(xs, ys)  # rows y (north), cols x (east)
    plat, plon = _to_latlon(lat0, lon0, x, y)
    azimuths = np.arange(0.0, 360.0, azimuth_step_deg)
    a = np.radians(azimuths)

    # True north at each point, as a grid azimuth: step 10 m north and re-project.
    qlat, qlon = destination(plat, plon, np.zeros_like(plat), np.full(plat.shape, 10.0))
    qx, qy = _grid_coords(lat0, lon0, qlat, qlon)
    gamma = np.degrees(np.arctan2(qx - x, qy - y))

    g = sub_step * spacing
    near_radius = near_radius_m if near_radius_m is not None else max(5_000.0, 8 * g)
    near_reach = near_radius + g * np.sqrt(2)

    # ---- near grid, aligned so that every node is a near-grid node
    k = max(1, int(np.ceil(spacing / near_target_m)))
    s = spacing / k
    near_d = [s]
    while near_d[-1] < near_reach:
        near_d.append(near_d[-1] + max(s, 0.01 * near_d[-1]))
    near_d = np.asarray(near_d)
    m = int(np.ceil(near_d[-1] / s)) + 2  # the last step may overshoot near_reach
    gx_axis = x0 + np.arange(-m, (nx - 1) * k + m + 1) * s
    gy_axis = y0 + np.arange(-m, (ny - 1) * k + m + 1) * s
    gx, gy = np.meshgrid(gx_axis, gy_axis)
    glat, glon = _to_latlon(lat0, lon0, gx, gy)
    grid = near_surface(glat, glon)
    despiked = 0
    near_cell = getattr(near_surface, "cell_m", None)
    if near_cell:
        grid, despiked = despike(grid, s, max(s, near_cell(lat0, lon0)))
    timings["near_grid"] = time.perf_counter() - t0
    span_x, span_y = (nx - 1) * k + 1, (ny - 1) * k + 1
    ground = grid[m:m + span_y:k, m:m + span_x:k].copy()
    h_p = ground + mast_height_m

    # Near rays. For one (direction, distance) the offset is the same for every
    # node, so a bilinear sample for all nodes is four strided slices. Compare
    # tan(elevation) = up / horizontal instead of the angle (monotonic):
    #   up = dh cos(theta) - (R + h_P)(1 - cos(theta)),  dh = h_Q - h_P
    #   horizontal = (R + h_P + dh) sin(theta)
    gridf = grid.astype(np.float32)
    hp32 = h_p.astype(np.float32)
    rp32 = (R + h_p).astype(np.float32)
    best = np.empty((ny, nx), np.float32)
    acc = np.empty((ny, nx), np.float32)
    tmp = np.empty((ny, nx), np.float32)
    num = np.empty((ny, nx), np.float32)
    horizon = np.empty((ny, nx, len(a)), np.float32)
    t1 = time.perf_counter()
    theta = near_d / R
    cos_t = np.cos(theta).astype(np.float32)
    sin_t = np.sin(theta).astype(np.float32)
    one_minus = (2 * np.sin(theta / 2) ** 2).astype(np.float32)
    for ia, az in enumerate(a):
        best.fill(-np.inf)
        sa, ca = np.sin(az), np.cos(az)
        for d_i, d in enumerate(near_d):
            fx, fy = d * sa / s, d * ca / s
            c0, r0 = int(np.floor(fx)), int(np.floor(fy))
            tx, ty = np.float32(fx - c0), np.float32(fy - r0)
            rs, cs = m + r0, m + c0
            np.multiply(gridf[rs:rs + span_y:k, cs:cs + span_x:k], (1 - tx) * (1 - ty), out=acc)
            np.multiply(gridf[rs:rs + span_y:k, cs + 1:cs + 1 + span_x:k], tx * (1 - ty), out=tmp)
            acc += tmp
            np.multiply(gridf[rs + 1:rs + 1 + span_y:k, cs:cs + span_x:k], (1 - tx) * ty, out=tmp)
            acc += tmp
            np.multiply(gridf[rs + 1:rs + 1 + span_y:k, cs + 1:cs + 1 + span_x:k], tx * ty, out=tmp)
            acc += tmp
            acc -= hp32  # dh
            np.multiply(acc, cos_t[d_i], out=num)
            np.multiply(rp32, one_minus[d_i], out=tmp)
            num -= tmp  # up
            acc += rp32
            acc *= sin_t[d_i]  # horizontal
            np.divide(num, acc, out=num)
            np.fmax(best, num, out=best)
        horizon[:, :, ia] = best
    horizon = np.arctan(horizon.astype(np.float64))
    timings["near"] = time.perf_counter() - t1

    # ---- far rays from the sub-grid (every sub_step-th node, plus the last)
    t2 = time.perf_counter()
    sub_i = np.unique(np.r_[np.arange(0, nx, sub_step), nx - 1])
    sub_j = np.unique(np.r_[np.arange(0, ny, sub_step), ny - 1])
    gj, gi = np.meshgrid(sub_j, sub_i, indexing="ij")  # rows j (y), cols i (x)
    gh = h_p[gj, gi]
    far_d = [near_radius]
    while far_d[-1] < max_range_m:
        far_d.append(far_d[-1] + max(FAR_MIN_STEP_M, DEFAULT_RELATIVE_STEP * far_d[-1]))
    far_d = np.asarray(far_d)
    if hasattr(far_surface, "preload"):
        # Pixels every far ray can reach: rings at max_range around the block's corners.
        ring = np.arange(0.0, 360.0, 2.0)
        corners = [(0, 0), (0, nx - 1), (ny - 1, 0), (ny - 1, nx - 1)]
        clat, clon = zip(*[destination(plat[j, i], plon[j, i], ring, np.full(ring.shape, max_range_m + 2_000.0))
                           for j, i in corners])
        far_surface.preload(np.concatenate(clat), np.concatenate(clon))
    far_h = np.empty(gj.shape + (len(a),))
    far_dist = np.empty_like(far_h)

    def far_node(jj, ii):  # nodes are independent and write disjoint slices
        j, i = gj[jj, ii], gi[jj, ii]
        bearing = azimuths - gamma[j, i]  # grid azimuth -> true bearing
        rlat, rlon = destination(plat[j, i], plon[j, i], bearing[:, None], far_d[None, :])
        elev = _elevation(far_surface(rlat, rlon), gh[jj, ii], far_d[None, :])
        elev = np.where(np.isfinite(elev), elev, -np.inf)
        top = np.argmax(elev, axis=1)
        far_h[jj, ii] = elev[np.arange(len(a)), top]
        far_dist[jj, ii] = far_d[top]

    nodes = [(jj, ii) for jj in range(gj.shape[0]) for ii in range(gj.shape[1])]
    if far_workers > 1 and len(nodes) > 1:
        with ThreadPoolExecutor(max_workers=far_workers) as pool:
            list(pool.map(lambda node: far_node(*node), nodes))  # list() re-raises a worker's error
    else:
        for node in nodes:
            far_node(*node)
    timings["far"] = time.perf_counter() - t2

    # Bilinear in the sub-grid with a height correction per corner (radians,
    # small angles): far(P) = sum_k w_k (H_k + (h_k - h_P) / D_k)
    #                       = interp(H + h / D) - h_P interp(1 / D).
    norm_p = _bilinear_rows_cols(far_h + gh[..., None] / far_dist, sub_j, sub_i, ny, nx)
    inv_p = _bilinear_rows_cols(1.0 / far_dist, sub_j, sub_i, ny, nx)
    far_p = norm_p - h_p[..., None] * inv_p
    horizon = np.degrees(np.fmax(horizon, far_p)).astype(np.float32)
    timings["total"] = time.perf_counter() - t0
    return {
        "lat": plat, "lon": plon, "ground_m": ground, "gamma_deg": gamma, "horizon_deg": horizon,
        "azimuth_deg": azimuths, "timings_s": timings,
        "params": {"near_spacing_m": s, "near_radius_m": near_radius, "near_reach_m": float(near_reach),
                   "near_grid_despiked": despiked,
                   "near_samples_per_ray": int(len(near_d)), "far_subgrid_m": g,
                   "far_subgrid_points": int(gj.size), "far_samples_per_ray": int(len(far_d)),
                   "max_range_m": max_range_m},
    }


def _bilinear_rows_cols(arr, sub_j, sub_i, ny, nx):
    """Bilinear from sub-grid nodes (rows sub_j, cols sub_i) to every node."""
    fj = np.interp(np.arange(ny), sub_j, np.arange(len(sub_j)))
    fi = np.interp(np.arange(nx), sub_i, np.arange(len(sub_i)))
    j0 = np.minimum(np.floor(fj).astype(int), max(len(sub_j) - 2, 0))
    i0 = np.minimum(np.floor(fi).astype(int), max(len(sub_i) - 2, 0))
    tj = (fj - j0)[:, None, None]
    ti = (fi - i0)[None, :, None]
    j1 = np.minimum(j0 + 1, len(sub_j) - 1)
    i1 = np.minimum(i0 + 1, len(sub_i) - 1)
    rows0 = arr[j0][:, i0] * (1 - ti) + arr[j0][:, i1] * ti
    rows1 = arr[j1][:, i0] * (1 - ti) + arr[j1][:, i1] * ti
    return rows0 * (1 - tj) + rows1 * tj


def build_horizon_maps(near_surface, far_surface, lat, lon, diameter_m, *, mast_height_m=DEFAULT_MAST_HEIGHT_M,
                       points_across=DEFAULT_POINTS_ACROSS, azimuth_step_deg=DEFAULT_AZIMUTH_STEP_DEG,
                       max_range_m=300_000.0, near_target_m=NEAR_TARGET_M) -> HorizonMaps:
    """Horizon maps on a grid centred on the site (points_across nodes across the
    diameter). See compute_block; lunar.horizon_tiles reuses blocks across sites."""
    n = points_across | 1
    spacing = diameter_m / (n - 1)
    half = (n - 1) // 2
    block = compute_block(near_surface, far_surface, lat, lon, -half * spacing, -half * spacing, n, n, spacing,
                          mast_height_m=mast_height_m, azimuth_step_deg=azimuth_step_deg, max_range_m=max_range_m,
                          near_target_m=near_target_m, sub_step=max(1, (n - 1) // 10))
    xy = (np.arange(n) - half) * spacing
    x, y = np.meshgrid(xy, xy)
    in_disc = np.hypot(x, y) <= diameter_m / 2 + 1e-6
    horizon = block["horizon_deg"]
    horizon[~in_disc] = np.nan
    return HorizonMaps(
        lat=lat, lon=lon, diameter_m=diameter_m, mast_height_m=mast_height_m, spacing_m=spacing,
        xy_m=xy, in_disc=in_disc, point_lat=block["lat"], point_lon=block["lon"], ground_m=block["ground_m"],
        gamma_deg=block["gamma_deg"], azimuth_deg=block["azimuth_deg"], horizon_deg=horizon,
        params=block["params"], timings_s=block["timings_s"],
    )


def direct_horizon(near_surface, far_surface, switch_m, lat, lon, mast_height_m, true_bearings_deg,
                   max_range_m=300_000.0, min_step_m=10.0, relative_step=DEFAULT_RELATIVE_STEP):
    """Reference for tests: horizon (deg) at one point by direct geodesic rays,
    independent of the near grid and the far sub-grid. Bearings are TRUE bearings
    at the point. Heights from near_surface up to switch_m, far_surface beyond.
    Steps: min_step_m, growing by max(min_step_m, relative_step d)."""
    d = [min_step_m]
    while d[-1] < max_range_m:
        d.append(d[-1] + max(min_step_m, relative_step * d[-1]))
    d = np.asarray(d)
    h_p = float(near_surface(np.array([lat]), np.array([lon]))[0]) + mast_height_m
    b = np.asarray(true_bearings_deg, float)
    rlat, rlon = destination(lat, lon, b[:, None], d[None, :])
    close = np.broadcast_to(d[None, :] <= switch_m, rlat.shape)
    h_q = np.empty(rlat.shape)
    h_q[close] = near_surface(rlat[close], rlon[close])
    h_q[~close] = far_surface(rlat[~close], rlon[~close])
    elev = _elevation(h_q, h_p, d[None, :])
    return np.degrees(np.nanmax(elev, axis=1))

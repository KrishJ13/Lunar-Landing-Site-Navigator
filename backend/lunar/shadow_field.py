"""Nested height grids around a site for shadows computed on the GPU (Skyline V3).

The browser marches a straight 3-D ray from each visible ground point towards
the Sun and tests it against these grids, every frame (as GPU terrain shadow
tools do), so shadows cover the whole view and follow the timeline smoothly.
lunar.horizon_maps stays the reference for numbers (sunlit %, power).

Grids
-----
LEVELS nested square grids in the site's azimuthal-equidistant plane (x east,
y north, metres along the surface), each SIZE x SIZE texel centres:
    x_i = -half + (i + 1/2) * 2 half / SIZE
Heights (m above the 1737.4 km sphere) come from `surface`, the same surface the
panorama is drawn from. They travel as uint16: h = lo + q * scale, q = 65535
where no map covers the point (it then never blocks).

Ray march (reference: march_lit_fraction; the GPU does the same)
---------------------------------------------------------------
Site frame: origin at the sphere centre, z = the site's up. A grid point (x, y)
with height h is at (R + h)(sin(rho/R) sin a, sin(rho/R) cos a, cos(rho/R)), rho = |(x, y)|,
a = atan2(x, y) (see _point). From a ground
point P (plus `lift` metres), the ray Q(t) = P + t s towards the Sun. At each
step the ray's own height above the sphere, h_ray = |Q| - R, is compared with
the terrain height under it (the finest grid covering its AE position). The Sun
is fully hidden below the terrain when the clearance angle
    c = min over t of (h_ray - h_terrain) / t
is below -r (r = Sun's angular radius) and fully visible above +r; between, the
visible fraction of a disc whose centre sits c above a straight edge:
    f = 1 - (acos(u) - u sqrt(1 - u^2)) / pi,  u = clamp(c / r, -1, 1).
Steps: t_0 = 1.5 cells of the finest grid at P, t_{k+1} = t_k + max(cell(t_k), 0.02 t_k),
to MAX_REACH_M.
"""

from __future__ import annotations

import numpy as np

from .config import MOON_RADIUS_M as R
from .despike import despike
from .geometry import destination

LEVELS = (768.0, 6_000.0, 30_000.0, 150_000.0, 600_000.0)  # half-widths, metres (1.5 m to 1.17 km)
SIZE = 1024
MAX_REACH_M = 400_000.0
NO_DATA = 65535


def build_field(surface, lat, lon, levels=LEVELS, size=SIZE, source_cell=None):
    """[{"half_m", "size", "spacing_m", "lo_m", "scale_m", "q" (size, size) uint16, "despiked"}],
    finest first. source_cell(distance_m) gives the source map's cell at a distance
    from the site; with it, each level fine enough to resolve that cell (spacing
    <= the cell) is spike-corrected (lunar.despike) on the scale of the cell."""
    out = []
    for half in levels:
        axis = -half + (np.arange(size) + 0.5) * (2 * half / size)
        x, y = np.meshgrid(axis, axis)  # rows y (north), cols x (east)
        qlat, qlon = destination(lat, lon, np.degrees(np.arctan2(x, y)), np.hypot(x, y))
        h = np.asarray(surface(qlat, qlon), float)
        corrected = 0
        if source_cell is not None:
            spacing = 2 * half / size
            cell = float(source_cell(half / 2))
            # Only where the grid resolves the source map: on a coarser grid a narrow
            # real summit is merely undersampled, not an artefact.
            if spacing <= 1.05 * cell:
                h, corrected = despike(h, spacing, max(spacing, cell))
        ok = np.isfinite(h)
        lo = float(h[ok].min()) if ok.any() else 0.0
        hi = float(h[ok].max()) if ok.any() else 1.0
        scale = max(hi - lo, 1e-3) / 65534.0
        q = np.full(h.shape, NO_DATA, np.uint16)
        q[ok] = np.rint((h[ok] - lo) / scale).astype(np.uint16)
        out.append({"half_m": half, "size": size, "spacing_m": 2 * half / size, "lo_m": lo, "scale_m": scale,
                    "max_m": hi, "q": q, "despiked": corrected})
    return out


def heights(field, x, y):
    """Bilinear height at AE points (x, y) from the finest covering grid; -inf where none."""
    x, y = np.broadcast_arrays(np.asarray(x, float), np.asarray(y, float))
    out = np.full(x.shape, -np.inf)
    todo = np.ones(x.shape, bool)
    for g in field:
        n, half = g["size"], g["half_m"]
        fx = (x + half) / g["spacing_m"] - 0.5
        fy = (y + half) / g["spacing_m"] - 0.5
        take = todo & (fx >= 0) & (fx <= n - 1) & (fy >= 0) & (fy <= n - 1)
        if not take.any():
            continue
        c0 = np.minimum(np.floor(fx[take]).astype(int), n - 2)
        r0 = np.minimum(np.floor(fy[take]).astype(int), n - 2)
        tx, ty = fx[take] - c0, fy[take] - r0
        q = g["q"]
        corners = [q[r0, c0], q[r0, c0 + 1], q[r0 + 1, c0], q[r0 + 1, c0 + 1]]
        bad = np.any([c == NO_DATA for c in corners], axis=0)
        hv = [g["lo_m"] + c.astype(float) * g["scale_m"] for c in corners]
        val = (hv[0] * (1 - tx) + hv[1] * tx) * (1 - ty) + (hv[2] * (1 - tx) + hv[3] * tx) * ty
        val[bad] = -np.inf
        out[take] = val
        todo &= ~take
    return out


def finest_cell(field, x, y):
    cell = np.full(np.shape(x), field[-1]["spacing_m"])
    for g in reversed(field):
        inside = (np.abs(x) < g["half_m"]) & (np.abs(y) < g["half_m"])
        cell = np.where(inside, g["spacing_m"], cell)
    return cell


def _point(x, y, h):
    """Site-frame 3-D position (sphere centre origin, z = site up) of AE point (x, y) at height h."""
    rho = np.hypot(x, y)
    theta = rho / R
    a = np.arctan2(x, y)
    r = R + h
    return np.stack([r * np.sin(theta) * np.sin(a), r * np.sin(theta) * np.cos(a), r * np.cos(theta)], axis=-1)


def _ae(p):
    """AE (x, y) and height above the sphere of site-frame points p (..., 3)."""
    r = np.linalg.norm(p, axis=-1)
    theta = np.arccos(np.clip(p[..., 2] / r, -1, 1))
    a = np.arctan2(p[..., 0], p[..., 1])
    return R * theta * np.sin(a), R * theta * np.cos(a), r - R


def march_lit_fraction(field, x, y, sun_dir, sun_radius_rad, lift_m=0.0):
    """Reference ray march (see module docstring) at ground points (x, y) for a Sun in
    unit direction sun_dir (site ENU at the site; parallel rays). Returns 0..1."""
    x, y = np.atleast_1d(np.asarray(x, float)), np.atleast_1d(np.asarray(y, float))
    h0 = heights(field, x, y)
    p = _point(x, y, h0 + lift_m)
    s = np.asarray(sun_dir, float) / np.linalg.norm(sun_dir)
    t = 1.5 * finest_cell(field, x, y)
    clearance = np.full(x.shape, np.inf)
    top = max(g["max_m"] for g in field)
    active = np.ones(x.shape, bool)
    while active.any():
        q = p[active] + t[active, None] * s
        qx, qy, qh = _ae(q)
        ground = heights(field, qx, qy)
        clearance[active] = np.minimum(clearance[active], (qh - ground) / t[active])
        step = np.maximum(finest_cell(field, qx, qy), 0.02 * t[active])
        t[active] = t[active] + step
        idx = np.flatnonzero(active)
        done = (t[idx] > MAX_REACH_M) | (qh > top)
        active[idx[done]] = False
    u = np.clip(clearance / sun_radius_rad, -1, 1)
    return 1 - (np.arccos(u) - u * np.sqrt(1 - u * u)) / np.pi

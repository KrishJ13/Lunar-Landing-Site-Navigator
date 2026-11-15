"""Illumination over time from horizon maps (lunar.horizon_maps): for every
power-grid point and time step, the fraction of the Sun's disc above the terrain.

Per time step t (Sun centre S(t), Moon-fixed, from SPICE) and point P
(position (R + ground + mast) U(P)):
    v = S - P                         exact parallax; no shared Sun direction
    azimuth A, elevation e of v in P's own East/North/Up frame
    r = asin(R_sun / |v|)             Sun's angular radius
    grid azimuth = A + gamma(P)       (lunar.horizon_maps: true north at gamma)
Visible fraction of the disc: as lib/view.js bodyVisibility, the round disc is
cut into DISC_COLUMNS vertical chords at azimuth offsets x (|x| <= r), chord
e +- h with h = sqrt(r^2 - x^2); the part above the horizon H(az + x)
(linear between the map's 1 deg samples) is clamp(e + h - max(e - h, H), 0, 2h);
fraction = sum(visible) / sum(2h).
"""

from __future__ import annotations

import numpy as np

from .config import MOON_RADIUS_M as R
from .geometry import dot, enu_basis, unit_up

DISC_COLUMNS = 16
DARK = 0.001  # below this visible fraction a point counts as dark


def horizon_at(horizon_deg, step_deg, azimuth_deg, rows=None):
    """Horizon (deg) at azimuths (M, K) of maps horizon_deg[rows] (rows (M,), default
    0..N-1 for maps (N, A)): linear between samples, wrapping at 360."""
    a = np.mod(azimuth_deg, 360.0) / step_deg
    count = horizon_deg.shape[1]
    i0 = np.floor(a).astype(int) % count
    i1 = (i0 + 1) % count
    t = a - np.floor(a)
    rows = (np.arange(horizon_deg.shape[0]) if rows is None else rows)[:, None]
    return horizon_deg[rows, i0] * (1 - t) + horizon_deg[rows, i1] * t


def visible_fraction(horizon_deg, step_deg, azimuth_deg, elevation_deg, radius_deg, columns=DISC_COLUMNS, rows=None):
    """Visible fraction (M,) of discs at (azimuth, elevation, radius) (M,) above maps
    horizon_deg[rows] (see horizon_at)."""
    x = radius_deg[:, None] * (((np.arange(columns) + 0.5) / columns) * 2 - 1)[None, :]
    h = np.sqrt(np.maximum(radius_deg[:, None] ** 2 - x ** 2, 0.0))
    top = horizon_at(horizon_deg, step_deg, azimuth_deg[:, None] + x, rows)
    e = elevation_deg[:, None]
    seen = np.clip(e + h - np.maximum(e - h, top), 0.0, 2 * h)
    return seen.sum(axis=1) / (2 * h).sum(axis=1)


def illumination_series(hm, sun_m, sun_radius_m):
    """Visible fraction (T, ny, nx) for Sun positions sun_m (T, 3) in metres.
    Points outside the disc get 0. Also returns the Sun's (azimuth, elevation)
    at the site centre (true, degrees) per time step."""
    inside = hm.in_disc
    lat, lon = hm.point_lat[inside], hm.point_lon[inside]
    east, north, up = enu_basis(lat, lon)
    position = (R + hm.ground_m[inside] + hm.mast_height_m)[:, None] * unit_up(lat, lon)
    maps = hm.horizon_deg[inside].astype(float)
    gamma = hm.gamma_deg[inside]
    step = float(hm.azimuth_deg[1] - hm.azimuth_deg[0])
    c_east, c_north, c_up = enu_basis(hm.lat, hm.lon)
    centre_ground = getattr(hm, "centre_ground_m", None)
    if centre_ground is None:
        centre_ground = hm.ground_m[hm.ground_m.shape[0] // 2, hm.ground_m.shape[1] // 2]
    c_pos = (R + centre_ground + hm.mast_height_m) * unit_up(hm.lat, hm.lon)

    lit = np.zeros((len(sun_m),) + inside.shape, dtype=float)
    sun_m = np.asarray(sun_m, float)
    count = len(position)
    chunk = max(1, 400_000 // max(count, 1))  # time steps per vectorised pass
    for k0 in range(0, len(sun_m), chunk):
        s = sun_m[k0:k0 + chunk]  # (T, 3)
        v = s[:, None, :] - position[None, :, :]  # (T, N, 3)
        dist = np.linalg.norm(v, axis=-1)
        az = np.degrees(np.arctan2(dot(v, east), dot(v, north)))
        el = np.degrees(np.arcsin(np.clip(dot(v, up) / dist, -1, 1)))
        radius = np.degrees(np.arcsin(sun_radius_m / dist))
        rows = np.tile(np.arange(count), len(s))
        frac = visible_fraction(maps, step, (az + gamma).ravel(), el.ravel(), radius.ravel(), rows=rows)
        lit[k0:k0 + len(s), inside] = frac.reshape(len(s), count)
    vc = sun_m - c_pos
    centre_az = np.degrees(np.arctan2(dot(vc, c_east), dot(vc, c_north))) % 360.0
    centre_el = np.degrees(np.arcsin(dot(vc, c_up) / np.linalg.norm(vc, axis=-1)))
    return lit, centre_az, centre_el


def summarise(lit, in_disc, step_hours):
    """Per point: mean visible fraction (time-averaged, partial Sun counted
    fractionally) and the longest run of consecutive dark steps, in hours."""
    mean = lit.mean(axis=0)
    run = np.zeros(lit.shape[1:])
    longest = np.zeros(lit.shape[1:])
    for frame in lit:
        dark = frame < DARK
        run = np.where(dark, run + 1, 0)
        np.maximum(longest, run, out=longest)
    mean[~in_disc] = np.nan
    longest = longest * step_hours
    longest[~in_disc] = np.nan
    return mean, longest

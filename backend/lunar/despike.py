"""Correction of isolated spikes and pits in gridded elevation (LOLA artefacts).

LOLA-derived grids occasionally carry single-pixel outliers: a bad laser return
or an interpolation artefact between sparse tracks, e.g. +130 m in one sample of
ldem_512 at the connecting ridge. On a regular grid of heights (any resampling
of a map with source cell `cell_m`) a point is corrected when it stands apart
from everything around it, which real terrain does not:

For each node, with rings of 8 nodes at offsets r1 and r2 = 2 r1 (in nodes),
r1 = ceil(1.5 cell_m / spacing_m), so the rings lie outside a spike's footprint
(bilinear resampling spreads a source pixel over one cell each side):
    m1, m2   medians of the rings
    s1       median absolute deviation of ring 1 (local roughness)
    p        2 m1 - m2  (the radial profile continued inward: a cone or a
             ridge crest is predicted, an isolated spike is not)
    tol      max(MIN_TOL_M, CELL_FRACTION * cell_m, K_MAD * s1)
A node is a spike when it stands above EVERY ring-1 sample and above the
extrapolation, both by more than tol:
    h - max(ring 1) > tol  and  h - p > tol      (a pit: min(ring 1) - h > tol and p - h > tol)
and it is replaced by p clipped to [min(ring 1), max(ring 1)]. A ridge crest or a
crater rim always has ring samples along it at its own height, and a summit or a
slope is continued by p, so real terrain is kept; only a point higher (or lower)
than all of its surroundings by more than the local roughness, narrower than
~1.5 source cells, is treated as an artefact (the data cannot resolve it anyway).
Applied once per grid; corrected counts are reported.
"""

from __future__ import annotations

import math

import numpy as np

MIN_TOL_M = 8.0
CELL_FRACTION = 0.3
K_MAD = 4.0

_RING = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def _ring(h, r):
    """(8, ny, nx) heights at the 8 ring offsets r (edge nodes repeat the border)."""
    padded = np.pad(h, r, mode="edge")
    ny, nx = h.shape
    return np.stack([padded[r + dy * r:r + dy * r + ny, r + dx * r:r + dx * r + nx] for dy, dx in _RING])


def despike(heights, spacing_m, cell_m):
    """Corrected copy of a 2-D height grid (NaN kept) and the number of nodes changed."""
    h = np.asarray(heights, dtype=float)
    r1 = max(1, math.ceil(1.5 * cell_m / spacing_m))
    if 2 * r1 >= min(h.shape):
        return h.copy(), 0
    ring1 = _ring(h, r1)
    ring2 = _ring(h, 2 * r1)
    # Judge only nodes whose rings are complete (not next to missing data).
    complete = np.isfinite(ring1).all(axis=0) & np.isfinite(ring2).all(axis=0)
    ring1 = np.where(np.isfinite(ring1), ring1, 0.0)
    ring2 = np.where(np.isfinite(ring2), ring2, 0.0)
    m1 = np.median(ring1, axis=0)
    m2 = np.median(ring2, axis=0)
    s1 = np.median(np.abs(ring1 - m1), axis=0)
    tol = np.maximum(max(MIN_TOL_M, CELL_FRACTION * cell_m), K_MAD * s1)
    predicted = 2 * m1 - m2
    hi, lo = ring1.max(axis=0), ring1.min(axis=0)
    up = (h - hi > tol) & (h - predicted > tol)
    down = (lo - h > tol) & (predicted - h > tol)
    spike = np.isfinite(h) & complete & (up | down)
    out = h.copy()
    out[spike] = np.clip(predicted, lo, hi)[spike]
    return out, int(spike.sum())

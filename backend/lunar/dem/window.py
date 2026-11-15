"""A dense in-memory window over a map's own pixel grid.

Far rays from a block of horizon-map points read millions of samples from one
map. Indexing a memory-mapped or remote grid sample by sample pays per-call
bookkeeping (block lookup, sorting) every time; copying the covered pixels once
into an ndarray and indexing that is much faster. The pixels are the map's own,
so bilinear results are identical. Indices outside the window fall back to the
original grid.
"""

from __future__ import annotations

import copy

import numpy as np

from ..despike import despike


class WindowData:
    """Rows [row0, row1) x columns [col0, col0 + width) of `data` held in memory.
    With wrap = the map's sample count (a global cylindrical map), columns are
    taken modulo wrap, so a window may straddle longitude 0/360."""

    def __init__(self, data, row0: int, row1: int, col0: int, width: int, wrap: int | None = None,
                 despike_cell_m: float | None = None, value_to_m: float = 1000.0):
        self._data = data
        self.shape = data.shape
        self.dtype = data.dtype
        self.row0, self.row1, self.col0, self.width, self.wrap = row0, row1, col0, width, wrap
        cols = np.arange(col0, col0 + width)
        if wrap:
            cols = np.mod(cols, wrap)
        # Contiguous column runs (two when the window straddles the seam).
        breaks = np.flatnonzero(np.diff(cols) != 1) + 1
        parts = []
        for run in np.split(cols, breaks):
            c0, c1 = int(run[0]), int(run[-1]) + 1
            parts.append(np.asarray(data.window(row0, row1, c0, c1)) if hasattr(data, "window")
                         else np.asarray(data[row0:row1, c0:c1]))
        self._window = np.concatenate(parts, axis=1)
        self.despiked = 0
        if despike_cell_m:
            # Native pixels: spacing = cell. Heights in the map's unit (km) -> metres and back.
            fixed, self.despiked = despike(self._window.astype(np.float64) * value_to_m, despike_cell_m, despike_cell_m)
            self._window = (fixed / value_to_m).astype(self._window.dtype)

    def _offset(self, cols):
        rel = cols - self.col0
        return np.mod(rel, self.wrap) if self.wrap else rel

    def __getitem__(self, key):
        rows, cols = key
        rows, cols = np.broadcast_arrays(np.asarray(rows), np.asarray(cols))
        rel = self._offset(cols)
        inside = (rows >= self.row0) & (rows < self.row1) & (rel >= 0) & (rel < self.width)
        if inside.all():
            return self._window[rows - self.row0, rel]
        out = np.empty(rows.shape, dtype=self._window.dtype)
        out[inside] = self._window[rows[inside] - self.row0, rel[inside]]
        out[~inside] = self._data[rows[~inside], cols[~inside]]
        return out


def windowed(product, lat, lon, margin: int = 3, despike_window: bool = False):
    """A copy of `product` whose pixels covering points (lat, lon) are held in
    memory. Returns the product unchanged when the window would be the whole map
    or the points are outside it."""
    if hasattr(product, "spec") and hasattr(type(product), "product"):  # LazyRemoteProduct
        return windowed(product.product, lat, lon, margin, despike_window)
    line, sample = product.projection.latlon_to_pixel(np.asarray(lat, float), np.asarray(lon, float))
    ok = np.isfinite(line) & np.isfinite(sample)
    if not ok.any():
        return product
    lines, samples = product.shape
    line, sample = line[ok], sample[ok]
    wrap = samples if product._wraps_longitude() else None
    if wrap:
        # Unwrap columns around the middle point so a seam-straddling set stays compact.
        mid = sample[len(sample) // 2]
        sample = mid + np.mod(sample - mid + wrap / 2, wrap) - wrap / 2
    r0 = max(0, int(np.floor(line.min())) - margin)
    r1 = min(lines, int(np.ceil(line.max())) + margin + 2)
    c0 = int(np.floor(sample.min())) - margin
    c1 = int(np.ceil(sample.max())) + margin + 2
    if not wrap:
        c0, c1 = max(0, c0), min(samples, c1)
    width = min(c1 - c0, wrap) if wrap else c1 - c0
    if (r1 - r0) * width > 60_000_000 or r1 <= r0 or width <= 0:  # > 240 MB: not worth it
        return product
    clone = copy.copy(product)
    clone.data = WindowData(product.data, r0, r1, c0, width, wrap,
                            despike_cell_m=float(product.pixel_size_m) if despike_window else None,
                            value_to_m=1000.0 * float(getattr(product, "km_scale", 1.0)))
    return clone

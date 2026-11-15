"""Observer-centred elevation patch shared by the panorama and site mesh."""

import numpy as np

from .dem import best_product
from .geometry import destination

FOREGROUND_DETAIL_M = 128.0
FOREGROUND_BLEND_M = 320.0


def foreground_weight(distance):
    t = np.clip((FOREGROUND_BLEND_M - distance) / (FOREGROUND_BLEND_M - FOREGROUND_DETAIL_M), 0, 1)
    return t * t * (3 - 2 * t)


def _neighbour_max(values):
    padded = np.pad(values, 1, mode="edge")
    rows, cols = values.shape
    return np.maximum.reduce([
        padded[y:y + rows, x:x + cols] for y in range(3) for x in range(3)
    ])


def correct_outliers(detail, reference, step, pixel_size):
    """Blend severe local disagreements back to a supporting DEM.

    Remove any shared height offset first. Allow larger differences where the
    reference shows steep terrain, and taper around suspect samples to avoid
    creating a sharp edge in the corrected terrain.
    """
    residual = detail - reference
    valid = np.isfinite(residual)
    if not valid.any():
        return detail
    offset = np.median(residual[valid])
    north, east = np.gradient(reference, step)
    tolerance = max(6, 1.6 * pixel_size) + 2 * pixel_size * np.hypot(north, east)
    suspect = valid & (np.abs(residual - offset) > tolerance)
    if not suspect.any() or suspect.sum() > valid.sum() / 5:
        return detail
    weight = suspect.astype(float)
    # Cover the interpolation footprint and taper out over the next few cells.
    for attenuation in (1, 1, 2 / 3, 1 / 2, 1 / 3):
        weight = np.maximum(weight, attenuation * _neighbour_max(weight))
    return np.where(valid & (weight > 0), detail - (residual - offset) * weight, detail)


class ForegroundSurface:
    def __init__(self, products, lat, lon, *, fallback=None):
        try:
            finest = best_product(products, lat, lon)
        except LookupError:
            if fallback is None:
                raise
            products = [fallback]
            finest = best_product(products, lat, lon)
        self.name = finest.name
        self.pixel_size_m = float(finest.pixel_size_m)
        self.step = self.pixel_size_m / 2
        half_cells = max(2, int(np.ceil(FOREGROUND_BLEND_M / self.step)) + 1)
        self.origin = -half_cells * self.step
        axis = np.arange(-half_cells, half_cells + 1) * self.step
        east, north = np.meshgrid(axis, axis)
        bearing = np.degrees(np.arctan2(east, north))
        lat_grid, lon_grid = destination(lat, lon, bearing, np.hypot(east, north))
        detail = finest.heights_m(lat_grid, lon_grid)
        reference = best_product(products, lat, lon, target_m=4.01 * self.pixel_size_m)
        if reference.pixel_size_m > self.pixel_size_m and reference.pixel_size_m <= 4.01 * self.pixel_size_m:
            detail = correct_outliers(detail, reference.heights_m(lat_grid, lon_grid),
                                      self.step, self.pixel_size_m)
        if fallback is not None and fallback is not finest:
            missing = ~np.isfinite(detail)
            if missing.any():
                detail[missing] = fallback.heights_m(lat_grid[missing], lon_grid[missing])
        self.height = detail
        north_slope, east_slope = np.gradient(detail, self.step)
        self.east = -east_slope
        self.north = -north_slope

    def _sample(self, data, east, north):
        x, y = (east - self.origin) / self.step, (north - self.origin) / self.step
        col, row = np.floor(x).astype(int), np.floor(y).astype(int)
        fx, fy = x - col, y - row
        low = data[row, col] * (1 - fx) + data[row, col + 1] * fx
        high = data[row + 1, col] * (1 - fx) + data[row + 1, col + 1] * fx
        return low * (1 - fy) + high * fy

    def blend(self, base, east, north, distance):
        detail = self._sample(self.height, east, north)
        weight = foreground_weight(distance)
        height = np.where(np.isfinite(base), base + (detail - base) * weight, detail)
        return np.where(np.isfinite(detail), height, base)

    def slopes(self, east, north):
        return self._sample(self.east, east, north), self._sample(self.north, east, north)

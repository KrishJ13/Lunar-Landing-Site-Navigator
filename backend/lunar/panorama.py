"""A fixed observer's 360° view of the DEM, with one radial profile per bearing."""

import numpy as np

from .config import MOON_RADIUS_M
from .dem import heights_at
from .foreground import FOREGROUND_BLEND_M, FOREGROUND_DETAIL_M, foreground_weight
from .geometry import destination
from .horizon import DEFAULT_RELATIVE_STEP, sample_distances
from .lola_chain import POLAR_BLEND

PANORAMA_ROWS = 1024
SPIKE_CORRECTION_STRENGTH = 90


def render_panorama(products, lat, lon, azimuths, eye_m, near_spacing, max_range, far_spacing, foreground, chain=None):
    """Return the skyline, skyline distance, and a bottom-to-top grayscale raster.

    The visible point at an elevation is the first outward crossing of that
    angle. A farther surface enters the image only when it clears closer ground.
    """
    step = near_spacing / 2
    detail_step = min(step, foreground.pixel_size_m / 2)
    detail_limit = POLAR_BLEND[1] if chain is not None and chain.polar is not None else FOREGROUND_DETAIL_M
    distances = np.unique(np.r_[np.geomspace(min(0.01, max_range), min(detail_step, max_range), 16),
                                np.arange(detail_step, min(detail_limit, max_range), detail_step),
                                sample_distances(max_range, step, DEFAULT_RELATIVE_STEP)])
    heights = np.empty((len(azimuths), len(distances)))
    bearings = np.radians(azimuths[:, None])

    # A fixed band blends the near and far DEMs independently of the landing
    # boundary. Request only the fine data within that band or nearer.
    blend_start, blend_end = 5_000.0, 10_000.0
    batch_size = max(1, 1_000_000 // len(azimuths))
    for start in range(0, len(distances), batch_size):
        stop = start + batch_size
        distance = distances[start:stop]
        ray_lat, ray_lon = destination(lat, lon, azimuths[:, None], distance[None, :])
        if chain is not None:
            heights[:, start:stop], _ = chain.sample(ray_lat, ray_lon, azimuths[:, None], distance)
            continue
        if len(products) == 1:
            heights[:, start:stop] = products[0].heights_m(ray_lat, ray_lon)
            continue
        near = distance < blend_end
        far = distance > blend_start
        lookup = np.full(ray_lat.shape, np.nan)
        if near.any():
            lookup[:, near], _ = heights_at(products, ray_lat[:, near], ray_lon[:, near], target_m=near_spacing)
        close = distance < FOREGROUND_BLEND_M
        if close.any():
            lookup[:, close] = foreground.blend(lookup[:, close], np.sin(bearings) * distance[close],
                                                np.cos(bearings) * distance[close], distance[close])
        if far.any():
            coarse, _ = heights_at(products, ray_lat[:, far], ray_lon[:, far], target_m=far_spacing)
            fine = lookup[:, far]
            t = np.clip((distance[far] - blend_start) / (blend_end - blend_start), 0, 1)
            t = t * t * (3 - 2 * t)
            lookup[:, far] = np.where(
                np.isfinite(fine) & np.isfinite(coarse), fine * (1 - t) + coarse * t,
                np.where(np.isfinite(coarse), coarse, fine),
            )
        heights[:, start:stop] = lookup

    if chain is not None:
        normal_spacing = chain.normal_spacing(distances)
    elif len(products) == 1:
        normal_spacing = np.full_like(distances, foreground.pixel_size_m)
    else:
        normal_spacing = np.interp(distances, [blend_start, blend_end], [near_spacing, far_spacing])
    _correct_isolated_peaks(heights, distances, azimuths, normal_spacing)

    theta = distances / MOON_RADIUS_M
    horizontal = (MOON_RADIUS_M + heights) * np.sin(theta)
    up = heights * np.cos(theta) - eye_m - 2 * MOON_RADIUS_M * np.sin(theta / 2) ** 2
    elevation = np.degrees(np.arctan2(up, horizontal))
    elevation = np.where(np.isfinite(elevation), elevation, -np.inf)
    peak = np.argmax(elevation, axis=1)
    skyline = elevation[np.arange(len(azimuths)), peak]
    if not np.isfinite(skyline).all():
        raise LookupError("Elevation maps do not cover all panorama directions.")

    relief = _relief(up, distances, azimuths, normal_spacing)
    # Evaluate the local surface normal at the actual DEM positions rather
    # than using a common tangent plane or a colour fill under the horizon.
    close = distances < FOREGROUND_BLEND_M
    local = _shade_from_slopes(*foreground.slopes(np.sin(bearings) * distances[close],
                                                   np.cos(bearings) * distances[close]))
    blend = foreground_weight(distances[close])
    relief[:, close] = np.where(np.isfinite(local), relief[:, close] * (1 - blend) + local * blend,
                                 relief[:, close])
    # Concentrate texture rows just below each skyline, where small angular
    # changes reveal large stretches of distant terrain.
    fraction = (1 - np.linspace(0, 1, PANORAMA_ROWS)) ** 3
    image = np.empty((PANORAMA_ROWS, len(azimuths)), dtype=np.uint8)
    for column, horizon in enumerate(skyline):
        angles = horizon - (horizon + 90) * fraction
        image[:, column] = _visible_shade(elevation[column], horizontal[column], up[column],
                                          distances, relief[column], angles)
    return skyline, distances[peak], image


def _correct_isolated_peaks(heights, distances, azimuths, spacing, strength=SPIKE_CORRECTION_STRENGTH):
    """Limit narrow peaks bounded by lower terrain both across and along a ray."""
    if strength == 0:
        return
    width = 1 + int(strength >= 50) + int(strength >= 85)
    radial = np.full_like(heights, np.inf)
    angular = np.full_like(heights, np.inf)
    columns = len(distances)
    for span in range(2, width + 2):
        for before in range(1, span):
            after = span - before
            if span < columns:
                core = slice(before, columns - after)
                outer = np.maximum(heights[:, :-span], heights[:, span:])
                reach = np.maximum(distances[core] - distances[:-span], distances[span:] - distances[core])
                valid = np.isfinite(outer) & (reach <= spacing[core])
                np.minimum(radial[:, core], outer, out=radial[:, core], where=valid)

            outer = np.maximum(np.roll(heights, before, axis=0), np.roll(heights, -after, axis=0))
            west = (azimuths - np.roll(azimuths, before)) % 360
            east = (np.roll(azimuths, -after) - azimuths) % 360
            reach = np.radians(np.maximum(west, east))[:, None] * distances
            valid = np.isfinite(outer) & (reach <= spacing)
            np.minimum(angular, outer, out=angular, where=valid)

    ceiling = np.maximum(radial, angular)
    tolerance = np.maximum(4 - 0.03 * strength, (0.24 - 0.002 * strength) * spacing)
    np.copyto(heights, ceiling, where=np.isfinite(heights) & (heights > ceiling + tolerance))


def _relief(up, distances, azimuths, spacing):
    """Estimate slopes over a DEM cell so bilinear pixel edges don't become stripes."""
    half = spacing / 2
    low = np.maximum(distances[0], distances - half)
    high = np.minimum(distances[-1], distances + half)
    radial = np.empty_like(up)
    for i, profile in enumerate(up):
        radial[i] = (np.interp(high, distances, profile) - np.interp(low, distances, profile)) / (high - low)

    step_deg = azimuths[1] - azimuths[0]
    offsets = np.maximum(1, np.ceil(np.degrees(np.arctan2(half, distances)) / step_deg)).astype(int)
    bearings = np.arange(len(azimuths))[:, None]
    west, east = (bearings - offsets) % len(azimuths), (bearings + offsets) % len(azimuths)
    span = np.radians((azimuths[east] - azimuths[west]) % 360)
    rings = np.arange(len(distances))
    across = (up[east, rings] - up[west, rings]) / (2 * np.sin(span / 2) * distances)
    azimuth = np.radians(azimuths[:, None])
    east = -np.nan_to_num(radial) * np.sin(azimuth) - np.nan_to_num(across) * np.cos(azimuth)
    north = -np.nan_to_num(radial) * np.cos(azimuth) + np.nan_to_num(across) * np.sin(azimuth)

    return _shade_from_slopes(east, north)


def _shade_from_slopes(east, north):
    light_z = 0.34
    cosine = (-0.72 * east + 0.60 * north + light_z) / np.sqrt(1 + east * east + north * north)
    slope = cosine - light_z
    return 0.47 + 0.42 * np.tanh(slope / 0.20)


def _visible_shade(elevation, horizontal, up, distances, relief, angles):
    # The running maximum is monotonic. Its first crossing identifies the
    # closest segment even when the profile dips behind ridges and rises again.
    end = np.searchsorted(np.maximum.accumulate(elevation), angles)
    end = np.minimum(end, len(distances) - 1)
    start = np.maximum(end - 1, 0)
    sin, cos = np.sin(np.radians(angles)), np.cos(np.radians(angles))
    before = horizontal[start] * sin - up[start] * cos
    after = horizontal[end] * sin - up[end] * cos
    denominator = before - after
    t = np.divide(before, denominator, out=np.ones_like(angles),
                  where=np.isfinite(denominator) & (denominator != 0))
    t = np.clip(t, 0, 1)
    distance = distances[start] + (distances[end] - distances[start]) * t
    shade = relief[start] + (relief[end] - relief[start]) * t
    depth = np.clip(np.log1p(distance) / np.log1p(15_000), 0, 1)
    return np.rint(255 * np.clip(shade * (0.55 + 0.45 * depth), 0, 1)).astype(np.uint8)

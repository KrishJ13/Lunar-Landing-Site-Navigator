"""Ridge crests seen from the observer (reconstruction step 1).

Goal: describe the surroundings as the set of ridges that shape the view,
computed from the elevation data, so the frontend can draw them as smooth
layers instead of rasterising the surface.

Along one compass direction, walking outward, theta(d) is the angle at which
the terrain at distance d appears above the eye's horizontal plane. A RIDGE
CREST is a local maximum of theta(d): the top of something, with the terrain
just behind it appearing lower. A crest is VISIBLE if nothing closer appears
higher. Only visible crests matter for the view; the last one is the skyline.

Accuracy:
  - heights come from a bicubic (Catmull-Rom) surface through the LOLA
    pixels, so theta(d) is smooth and its maxima are well defined;
  - each crest is refined BETWEEN samples by fitting a parabola through the
    three samples around the maximum, giving its angle and distance more
    precisely than the sample spacing;
  - a crest is kept only if the terrain behind it dips at least
    `min_dip_deg` below it before anything rises higher, i.e. it really hides
    something (filters tiny bumps and interpolation noise).

Output per direction: an array of crests, near to far, with columns
CREST_FIELDS. Linking crests across directions into ridgelines is step 2.
"""

from dataclasses import dataclass

import numpy as np

from .dem import DemProduct, heights_at
from .geometry import destination, look_angles, surface_vector
from .horizon import (
    DEFAULT_MAX_RANGE_M,
    DEFAULT_OBSERVER_HEIGHT_M,
    DEFAULT_RELATIVE_STEP,
    Observer,
    make_observer,
    sample_distances,
)

CREST_FIELDS = ("distance_m", "elevation_deg", "height_m", "lat", "lon", "skyline")
PROFILE_FIELDS = ("elevation_deg", "distance_m", "behind_ridge")
_PROFILE_DISTANCE_RATIO = 1.15  # keep a visible-profile point when distance changes by more than this
_PROFILE_DELTA_EL_DEG = 1.0  # ... or the elevation angle by more than this
DEFAULT_AZIMUTH_STEP_DEG = 0.25
DEFAULT_MIN_DIP_DEG = 0.01
_AZIMUTHS_PER_CHUNK = 48


@dataclass(frozen=True)
class CrestView:
    observer: Observer
    azimuth_deg: np.ndarray  # (A,)
    crests: list[np.ndarray]  # A arrays of shape (k, len(CREST_FIELDS)), near to far
    max_range_m: float
    # A arrays (k, len(PROFILE_FIELDS)): the visible terrain bottom to top, i.e.
    # the distance of what you see at each elevation angle; behind_ridge = 1
    # where that terrain emerges from behind a nearer crest (distance jumps).
    profiles: list[np.ndarray] | None = None


def _parabola_vertex(x0, y0, x1, y1, x2, y2):
    """Vertex (x, y) of the parabola through three points; x clamped to [x0, x2]."""
    denom = (x0 - x1) * (x0 - x2) * (x1 - x2)
    a = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / denom
    b = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / denom
    c = (x1 * x2 * (x1 - x2) * y0 + x2 * x0 * (x2 - x0) * y1 + x0 * x1 * (x0 - x1) * y2) / denom
    if a >= 0:  # not a maximum (flat or curving up): keep the sample itself
        return x1, y1
    xv = min(max(-b / (2 * a), x0), x2)
    return xv, a * xv * xv + b * xv + c


def find_crests(distance_m: np.ndarray, elevation_deg: np.ndarray, min_dip_deg: float = DEFAULT_MIN_DIP_DEG):
    """Visible ridge crests along one ray, near to far.

    Returns a list of (distance_m, elevation_deg, sample_index, is_skyline).
    """
    d = np.asarray(distance_m, dtype=float)
    el = np.asarray(elevation_deg, dtype=float)
    n = len(el)
    if n < 3:
        return []

    # Candidate crests: local maxima that are visible (higher than all closer terrain).
    closer_max = np.concatenate([[-np.inf], np.maximum.accumulate(el)[:-1]])
    is_peak = np.zeros(n, dtype=bool)
    is_peak[0] = el[0] > el[1]  # on high ground the nearest sample can be the highest
    is_peak[1:-1] = (el[1:-1] >= el[:-2]) & (el[1:-1] > el[2:])
    is_peak[-1] = el[-1] > closer_max[-1]  # rising to the end of the search range
    candidates = np.flatnonzero(is_peak & (el > closer_max))

    crests = []
    for idx, i in enumerate(candidates):
        if 0 < i < n - 1:
            dist, ang = _parabola_vertex(d[i - 1], el[i - 1], d[i], el[i], d[i + 1], el[i + 1])
        else:
            dist, ang = d[i], el[i]
        # Does the terrain behind dip enough before the next visible crest?
        nxt = candidates[idx + 1] if idx + 1 < len(candidates) else n
        behind = el[i + 1:nxt]
        is_last = idx == len(candidates) - 1
        # (measured on the sample itself: the refined vertex can overshoot on sharp data)
        if not is_last and (behind.size == 0 or el[i] - behind.min() < min_dip_deg):
            continue
        crests.append((dist, ang, i, False))
    if crests:
        last = crests[-1]
        crests[-1] = (last[0], last[1], last[2], True)
    return crests


def visible_profile(distance_m: np.ndarray, elevation_deg: np.ndarray) -> np.ndarray:
    """The visible terrain along one ray as (elevation, distance, behind_ridge)
    points, bottom to top, thinned where distance and angle change little."""
    el = np.asarray(elevation_deg, dtype=float)
    closer_max = np.concatenate([[-np.inf], np.maximum.accumulate(el)[:-1]])
    visible = np.flatnonzero(el > closer_max)
    rows: list[list[float]] = []
    prev = None
    for i in visible:
        behind = prev is not None and i - prev > 1  # hidden samples in between
        is_last = i == visible[-1]
        if rows and not behind and not is_last:
            last_el, last_d = rows[-1][0], rows[-1][1]
            if distance_m[i] / last_d < _PROFILE_DISTANCE_RATIO and el[i] - last_el < _PROFILE_DELTA_EL_DEG:
                prev = i
                continue
        rows.append([el[i], float(distance_m[i]), float(behind)])
        prev = i
    return np.asarray(rows, dtype=float).reshape(-1, len(PROFILE_FIELDS))


def compute_crests(
    products: list[DemProduct],
    lat: float,
    lon: float,
    height_above_ground_m: float = DEFAULT_OBSERVER_HEIGHT_M,
    azimuth_step_deg: float = DEFAULT_AZIMUTH_STEP_DEG,
    max_range_m: float = DEFAULT_MAX_RANGE_M,
    min_step_m: float | None = None,
    relative_step: float = DEFAULT_RELATIVE_STEP,
    min_dip_deg: float = DEFAULT_MIN_DIP_DEG,
) -> CrestView:
    """Visible ridge crests in every direction around the observer (bicubic surface)."""
    observer = make_observer(products, lat, lon, height_above_ground_m, method="bicubic")
    if min_step_m is None:
        min_step_m = observer.site_pixel_size_m / 2
    distances = sample_distances(max_range_m, min_step_m, relative_step)
    azimuths = np.arange(0.0, 360.0, azimuth_step_deg)

    all_crests: list[np.ndarray] = []
    profiles: list[np.ndarray] = []
    for start in range(0, len(azimuths), _AZIMUTHS_PER_CHUNK):
        az = azimuths[start:start + _AZIMUTHS_PER_CHUNK]
        ray_lat, ray_lon = destination(lat, lon, az[:, None], distances[None, :])
        terrain, _ = heights_at(products, ray_lat, ray_lon, method="bicubic")
        _, elevation, _ = look_angles(observer.position, surface_vector(ray_lat, ray_lon, terrain), observer.basis)
        for a in range(len(az)):
            profiles.append(visible_profile(distances, elevation[a]))
            rows = []
            for dist, ang, i, skyline in find_crests(distances, elevation[a], min_dip_deg):
                # Height and position at the refined distance (linear between samples).
                j = min(max(i, 1), len(distances) - 1)
                k = j - 1 if dist < distances[j] else j
                k2 = min(k + 1, len(distances) - 1)
                f = 0.0 if k2 == k else (dist - distances[k]) / (distances[k2] - distances[k])
                rows.append([
                    dist,
                    ang,
                    terrain[a, k] + (terrain[a, k2] - terrain[a, k]) * f,
                    ray_lat[a, k] + (ray_lat[a, k2] - ray_lat[a, k]) * f,
                    # longitude difference wrapped to (-180, 180] so 359.9 -> 0.1 interpolates correctly
                    (ray_lon[a, k] + ((ray_lon[a, k2] - ray_lon[a, k] + 540.0) % 360.0 - 180.0) * f) % 360.0,
                    float(skyline),
                ])
            all_crests.append(np.asarray(rows, dtype=float).reshape(-1, len(CREST_FIELDS)))
    return CrestView(
        observer=observer, azimuth_deg=azimuths, crests=all_crests, max_range_m=max_range_m, profiles=profiles
    )

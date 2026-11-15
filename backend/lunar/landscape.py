"""What the observer actually SEES below the skyline (component 7).

The skyline (component 4) is only the top edge of the terrain. To draw the
landscape, we also need every piece of terrain that is visible beneath it:
the nearby ground, a ridge in front of a mountain, the mountain behind.

For one compass direction, walking outward from the eye, a terrain sample is
VISIBLE if it appears higher than everything closer:

    visible[i]  <=>  theta[i] > max(theta[0..i-1])

Reading the visible samples in order gives the vertical strip of the view in
that direction, bottom to top. Between two consecutive visible samples i < j,
the angles theta[i]..theta[j] show the terrain around sample j. If samples
between i and j were hidden, j lies BEHIND a ridge: the strip jumps from near
terrain to far terrain there, which is a silhouette edge.

Each strip is returned as segments:
    [el_low_deg, el_high_deg, near_km, far_km, shade, edge, height_m]
  el_low/high  the angular extent of the segment in the view
  near/far_km  distance range of the terrain seen in this segment (the
               terrain at el_low is near_km away, at el_high far_km away)
  shade        0..1 brightness from the terrain slope (see below)
  edge         1 if this segment starts at a silhouette (terrain behind a ridge)
  height_m     terrain height at the top of the segment, vs mean level

Neighbouring samples are merged into one segment while the distance grows by
less than _MERGE_DISTANCE_RATIO and the shade stays similar, so a renderer
can colour each segment with a smooth distance gradient from near_km to far_km.

The bottom segment starts at -90 deg (looking straight down at your feet).
Above the last segment is sky.

Shading: the terrain surface normal comes from the elevation map gradient
(east/north slopes) at each sample. It is lit by a fixed light placed above
and slightly behind-left of the viewer, so slopes facing the viewer are
bright and slopes turned away are dark. This is a readability choice, NOT
real sunlight; real Sun lighting comes later from the ephemeris.
"""

from dataclasses import dataclass

import numpy as np

from .dem import DemProduct, heights_at
from .geometry import destination, dot, enu_basis, horizontal_direction, look_angles, surface_vector
from .horizon import (
    DEFAULT_MAX_RANGE_M,
    DEFAULT_OBSERVER_HEIGHT_M,
    DEFAULT_RELATIVE_STEP,
    Observer,
    make_observer,
    sample_distances,
)
from .skyline import (
    DEFAULT_AZIMUTH_STEP_DEG,
    HorizonProfile,
    _concatenate,
    azimuth_grid,
    sample_terrain_rays,
    skyline_for_observer,
)

# Light direction in the viewer's frame: (towards viewer, to the right, up).
_LIGHT_BACK, _LIGHT_RIGHT, _LIGHT_UP = 0.45, -0.35, 0.82
_AMBIENT = 0.25

_MERGE_SHADE = 0.08  # merge neighbouring samples whose shade differs less than this
_MERGE_DISTANCE_RATIO = 1.5  # ...and while far / first distance in the segment stays below this
_MIN_SEGMENT_DEG = 0.01  # thinner slivers are folded into the segment below
_AZIMUTHS_PER_CHUNK = 60


SEGMENT_FIELDS = ("el_low_deg", "el_high_deg", "near_km", "far_km", "shade", "edge", "height_m")


@dataclass(frozen=True)
class Landscape:
    azimuth_deg: np.ndarray  # (A,)
    segments: list[np.ndarray]  # A arrays of shape (n, 7), see SEGMENT_FIELDS


@dataclass(frozen=True)
class View:
    """Everything the first-person view needs for one eye height."""

    observer: Observer
    skyline: HorizonProfile
    landscape: Landscape
    # Per azimuth: where the Moon's mean level (height 0) would appear at the
    # skyline's distance. Skyline above this line = terrain above mean level.
    mean_level_elevation_deg: np.ndarray


def terrain_normals(products: list[DemProduct], lat, lon, step_m) -> np.ndarray:
    """Unit surface normals (Moon-fixed, (..., 3)) from the elevation map.

    Central differences over +/- step_m towards east and north:
        slope_e = (z(east) - z(west)) / (2 step),  slope_n similarly
        normal  = normalize(U - slope_e E - slope_n N)
    """
    lat, lon = np.asarray(lat), np.asarray(lon)
    step = np.broadcast_to(np.asarray(step_m, dtype=float), lat.shape)

    def h(az):
        la, lo = destination(lat, lon, az, step)
        return heights_at(products, la, lo)[0]

    slope_e = (h(90.0) - h(270.0)) / (2 * step)
    slope_n = (h(0.0) - h(180.0)) / (2 * step)
    east, north, up = enu_basis(lat, lon)
    n = up - slope_e[..., None] * east - slope_n[..., None] * north
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def _shade(normals: np.ndarray, observer, azimuths_deg: np.ndarray) -> np.ndarray:
    """Brightness 0..1 for normals (A, D, 3) on rays at azimuths (A,)."""
    forward = horizontal_direction(observer.lat, observer.lon, azimuths_deg)  # (A, 3)
    right = horizontal_direction(observer.lat, observer.lon, azimuths_deg + 90.0)
    up = observer.basis[2]
    light = -_LIGHT_BACK * forward + _LIGHT_RIGHT * right + _LIGHT_UP * up
    light /= np.linalg.norm(light, axis=-1, keepdims=True)
    lambert = np.clip(dot(normals, light[:, None, :]), 0.0, 1.0)
    return _AMBIENT + (1.0 - _AMBIENT) * lambert


def strip_segments(elevation, distance_m, shade, terrain_m) -> np.ndarray:
    """Visible segments for ONE azimuth, bottom to top (see module docstring)."""
    el = np.asarray(elevation)
    closer_max = np.concatenate([[-np.inf], np.maximum.accumulate(el)[:-1]])
    visible = np.flatnonzero(el > closer_max)

    rows: list[list[float]] = []  # [low, high, near_km, far_km, shade, edge, height_m]
    first_km = 0.0  # distance of the first sample in the current segment
    prev = None  # index of the previous visible sample
    for i in visible:
        km = distance_m[i] / 1000.0
        edge = prev is not None and i - prev > 1  # hidden samples in between: behind a ridge
        if prev is None:
            near = 0.0  # the first segment is the ground from your feet outward
        elif edge:
            near = km  # far terrain emerging from behind the ridge
        else:
            near = distance_m[prev] / 1000.0  # continuous slope from the previous sample

        if rows and not edge:
            last = rows[-1]
            similar = km <= first_km * _MERGE_DISTANCE_RATIO and abs(last[4] - shade[i]) < _MERGE_SHADE
            last_is_sliver = el[i] - last[0] < _MIN_SEGMENT_DEG
            if similar or last_is_sliver:
                last[1], last[3], last[6] = el[i], km, float(terrain_m[i])  # extend upward
                prev = i
                continue

        low = rows[-1][1] if rows else -90.0
        rows.append([low, el[i], near, km, float(shade[i]), float(edge), float(terrain_m[i])])
        first_km = km
        prev = i
    return np.asarray(rows, dtype=float).reshape(-1, len(SEGMENT_FIELDS))


def compute_view(
    products: list[DemProduct],
    lat: float,
    lon: float,
    height_above_ground_m: float = DEFAULT_OBSERVER_HEIGHT_M,
    azimuth_step_deg: float = DEFAULT_AZIMUTH_STEP_DEG,
    max_range_m: float = DEFAULT_MAX_RANGE_M,
    min_step_m: float | None = None,
    relative_step: float = DEFAULT_RELATIVE_STEP,
) -> View:
    """Skyline AND visible landscape for one observer height."""
    observer = make_observer(products, lat, lon, height_above_ground_m)
    if min_step_m is None:
        min_step_m = observer.site_pixel_size_m / 2
    distances = sample_distances(max_range_m, min_step_m, relative_step)
    azimuths = azimuth_grid(azimuth_step_deg)

    skyline_parts, segments = [], []
    for start in range(0, len(azimuths), _AZIMUTHS_PER_CHUNK):
        az = azimuths[start:start + _AZIMUTHS_PER_CHUNK]
        rays = sample_terrain_rays(products, lat, lon, az, distances)
        skyline_parts.append(skyline_for_observer(rays, observer, max_range_m))

        _, elevation, _ = look_angles(observer.position, rays.points, observer.basis)
        normals = terrain_normals(products, rays.lat, rays.lon, rays.pixel_size_m)
        shade = _shade(normals, observer, az)
        for a in range(len(az)):
            segments.append(strip_segments(elevation[a], distances, shade[a], rays.terrain_m[a]))

    skyline = _concatenate(skyline_parts)
    mean_level_points = surface_vector(skyline.skyline_lat, skyline.skyline_lon, 0.0)
    _, mean_level_el, _ = look_angles(observer.position, mean_level_points, observer.basis)
    return View(
        observer=observer,
        skyline=skyline,
        landscape=Landscape(azimuth_deg=azimuths, segments=segments),
        mean_level_elevation_deg=mean_level_el,
    )

"""The full 360-degree local horizon of a site (component 4).

Repeats the horizon ray (component 3) for every compass direction:

    H(A) = max over d of theta(A, d)        for A = 0, step, 2*step, ... < 360

and does so for several observer heights at once. The terrain along each ray
does not depend on how tall the observer is, so it is sampled ONCE and then
reused for every height; only the viewing angles are recomputed.

The result, one HorizonProfile per height, is the data behind the panorama
image: azimuth along the bottom, skyline elevation up the side.

Near-field terrain (a deliberate choice): samples start half a map pixel
from the site, and terrain there is interpolated between pixel centres.
For low observers (e.g. 2 m) on sloping ground, that nearby ground can form
the skyline in some directions (distance_m around one pixel). We keep this
as-is rather than excluding it; distance_m and skyline_pixel_size_m make it
visible when the skyline is set by ground the map barely resolves.

Function overview
    azimuth_grid(step)                              0, step, ... < 360
    sample_terrain_rays(maps, lat, lon, az, dist)   terrain along many rays (height-independent)
    skyline_for_observer(rays, observer)            H(A) for one eye height
    compute_skyline(maps, lat, lon, heights, ...)   everything, one profile per height
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

DEFAULT_AZIMUTH_STEP_DEG = 0.5
_AZIMUTHS_PER_CHUNK = 60  # bounds memory: 60 rays x ~1500 samples at a time


@dataclass(frozen=True)
class TerrainRays:
    """Terrain sampled along many rays from one site. Arrays are (azimuths, distances)."""

    azimuth_deg: np.ndarray  # (A,)
    distance_m: np.ndarray  # (D,)
    lat: np.ndarray  # (A, D)
    lon: np.ndarray  # (A, D)
    terrain_m: np.ndarray  # (A, D)
    pixel_size_m: np.ndarray  # (A, D) resolution each height came from
    points: np.ndarray  # (A, D, 3) Moon-fixed position of each terrain sample


@dataclass(frozen=True)
class HorizonProfile:
    """The skyline all around one observer. Per-azimuth arrays are (A,)."""

    lat: float
    lon: float
    ground_m: float
    height_above_ground_m: float
    site_pixel_size_m: float
    site_map_name: str
    max_range_m: float
    azimuth_deg: np.ndarray
    elevation_deg: np.ndarray  # skyline angle above the horizontal plane
    distance_m: np.ndarray  # distance to the skyline-forming terrain
    terrain_m: np.ndarray  # height of that terrain
    skyline_lat: np.ndarray
    skyline_lon: np.ndarray
    skyline_pixel_size_m: np.ndarray  # map resolution at the skyline point
    at_max_range: np.ndarray  # True where the skyline is the last sample


def azimuth_grid(step_deg: float = DEFAULT_AZIMUTH_STEP_DEG) -> np.ndarray:
    """Compass azimuths 0, step, 2*step, ... below 360."""
    return np.arange(0.0, 360.0, step_deg)


def sample_terrain_rays(
    products: list[DemProduct],
    lat: float,
    lon: float,
    azimuths_deg: np.ndarray,
    distances_m: np.ndarray,
) -> TerrainRays:
    """Terrain at every (azimuth, distance) sample around the site."""
    azimuths_deg = np.asarray(azimuths_deg, dtype=float)
    distances_m = np.asarray(distances_m, dtype=float)
    ray_lat, ray_lon = destination(lat, lon, azimuths_deg[:, None], distances_m[None, :])
    terrain, pixel_size = heights_at(products, ray_lat, ray_lon)
    return TerrainRays(
        azimuth_deg=azimuths_deg,
        distance_m=distances_m,
        lat=ray_lat,
        lon=ray_lon,
        terrain_m=terrain,
        pixel_size_m=pixel_size,
        points=surface_vector(ray_lat, ray_lon, terrain),
    )


def skyline_for_observer(rays: TerrainRays, observer: Observer, max_range_m: float) -> HorizonProfile:
    """For each ray, the terrain sample seen at the highest angle."""
    _, elevation, _ = look_angles(observer.position, rays.points, observer.basis)  # (A, D)
    best = np.nanargmax(elevation, axis=1)  # index of skyline sample on each ray
    rows = np.arange(len(rays.azimuth_deg))
    return HorizonProfile(
        lat=observer.lat,
        lon=observer.lon,
        ground_m=observer.ground_m,
        height_above_ground_m=observer.height_above_ground_m,
        site_pixel_size_m=observer.site_pixel_size_m,
        site_map_name=observer.site_map_name,
        max_range_m=max_range_m,
        azimuth_deg=rays.azimuth_deg,
        elevation_deg=elevation[rows, best],
        distance_m=rays.distance_m[best],
        terrain_m=rays.terrain_m[rows, best],
        skyline_lat=rays.lat[rows, best],
        skyline_lon=rays.lon[rows, best],
        skyline_pixel_size_m=rays.pixel_size_m[rows, best],
        at_max_range=best == len(rays.distance_m) - 1,
    )


def _concatenate(parts: list[HorizonProfile]) -> HorizonProfile:
    """Join profiles computed for consecutive chunks of azimuths."""
    first = parts[0]
    joined = {
        name: np.concatenate([getattr(p, name) for p in parts])
        for name, value in vars(first).items()
        if isinstance(value, np.ndarray)
    }
    scalars = {name: value for name, value in vars(first).items() if not isinstance(value, np.ndarray)}
    return HorizonProfile(**scalars, **joined)


def compute_skyline(
    products: list[DemProduct],
    lat: float,
    lon: float,
    heights_above_ground_m=(DEFAULT_OBSERVER_HEIGHT_M,),
    azimuth_step_deg: float = DEFAULT_AZIMUTH_STEP_DEG,
    max_range_m: float = DEFAULT_MAX_RANGE_M,
    min_step_m: float | None = None,
    relative_step: float = DEFAULT_RELATIVE_STEP,
) -> list[HorizonProfile]:
    """The 360-degree skyline at (lat, lon), one HorizonProfile per observer height.

    min_step_m defaults to half the pixel size of the map at the site.
    """
    observers = [make_observer(products, lat, lon, h) for h in heights_above_ground_m]
    if min_step_m is None:
        min_step_m = observers[0].site_pixel_size_m / 2
    distances = sample_distances(max_range_m, min_step_m, relative_step)
    azimuths = azimuth_grid(azimuth_step_deg)

    parts: list[list[HorizonProfile]] = [[] for _ in observers]
    for start in range(0, len(azimuths), _AZIMUTHS_PER_CHUNK):
        rays = sample_terrain_rays(products, lat, lon, azimuths[start:start + _AZIMUTHS_PER_CHUNK], distances)
        for i, observer in enumerate(observers):
            parts[i].append(skyline_for_observer(rays, observer, max_range_m))
    return [_concatenate(p) for p in parts]

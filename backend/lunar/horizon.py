"""The real local horizon along one compass direction (component 3).

Idea: stand at the site, face azimuth A, and walk outward along the surface.
At every sample distance d, look up the terrain height and compute the angle
at which that terrain point appears above (or below) your horizontal plane.
The highest such angle is where the skyline sits in direction A.

    theta(d) = elevation angle of terrain point at distance d
    H(A)     = max over d of theta(d)

Everything is exact 3D geometry (lunar.geometry), so the Moon's curvature is
built in: distant terrain naturally "drops away" below the horizontal.

Function overview
    make_observer(products, lat, lon, height)      where the eye is
    sample_distances(max_range, min_step, rel)     where along the ray to look
    ray_profile(products, observer, az, dists)     terrain + angles along the ray
    horizon_point(profile)                         the skyline point on that ray
    visible_mask(profile)                          which terrain the eye can see
    side_view(profile, observer)                   2D coordinates for a cross-section plot
    horizon_ray(...)                               all of the above in one call
"""

from dataclasses import dataclass

import numpy as np

from .dem import DemProduct, best_product, heights_at
from .geometry import destination, dot, enu_basis, horizontal_direction, look_angles, surface_vector

DEFAULT_MAX_RANGE_M = 200_000.0  # far enough for south pole massifs (Malapert is ~135 km from Shackleton)
DEFAULT_RELATIVE_STEP = 0.005  # each step is 0.5% of the distance so far
DEFAULT_OBSERVER_HEIGHT_M = 2.0  # eye level of a standing astronaut / small lander


@dataclass(frozen=True)
class Observer:
    lat: float
    lon: float
    ground_m: float  # terrain height at the site, above the 1737.4 km sphere
    height_above_ground_m: float  # eye / mast / antenna height
    position: np.ndarray  # (3,) Moon-fixed vector of the eye
    basis: tuple  # (east, north, up) unit vectors at the site
    site_pixel_size_m: float  # resolution of the map the site height came from
    site_map_name: str  # which elevation map the site height came from

    @property
    def eye_m(self) -> float:
        return self.ground_m + self.height_above_ground_m


@dataclass(frozen=True)
class RayProfile:
    azimuth_deg: float
    distance_m: np.ndarray  # along the surface from the site
    lat: np.ndarray
    lon: np.ndarray
    terrain_m: np.ndarray  # terrain height at each sample
    pixel_size_m: np.ndarray  # resolution of the map each height came from
    elevation_deg: np.ndarray  # apparent angle of each terrain point from the eye


@dataclass(frozen=True)
class HorizonPoint:
    azimuth_deg: float
    elevation_deg: float  # skyline angle above the horizontal plane
    distance_m: float  # how far away the skyline-forming terrain is
    lat: float
    lon: float
    terrain_m: float
    at_max_range: bool  # True if the skyline was the last sample: max range may be too short


def make_observer(
    products: list[DemProduct],
    lat: float,
    lon: float,
    height_above_ground_m: float = DEFAULT_OBSERVER_HEIGHT_M,
) -> Observer:
    """Put an eye `height_above_ground_m` above the terrain at (lat, lon)."""
    site_map = best_product(products, lat, lon)
    ground = site_map.height_m(lat, lon)
    return Observer(
        lat=lat,
        lon=lon,
        ground_m=ground,
        height_above_ground_m=height_above_ground_m,
        position=surface_vector(lat, lon, ground + height_above_ground_m),
        basis=enu_basis(lat, lon),
        site_pixel_size_m=site_map.pixel_size_m,
        site_map_name=site_map.name,
    )


def sample_distances(
    max_range_m: float = DEFAULT_MAX_RANGE_M,
    min_step_m: float = 120.0,
    relative_step: float = DEFAULT_RELATIVE_STEP,
) -> np.ndarray:
    """Distances to sample along a ray: fine nearby, coarser far away.

    step(d) = max(min_step_m, relative_step * d)

    A fixed angular error needs finer steps close up and allows coarser
    steps far away. min_step_m should be about half the elevation map's
    pixel size, because finer steps than that add no real information.
    """
    distances = []
    d = min_step_m
    while d < max_range_m:
        distances.append(d)
        d += max(min_step_m, relative_step * d)
    distances.append(max_range_m)
    return np.asarray(distances)


def ray_profile(
    products: list[DemProduct],
    observer: Observer,
    azimuth_deg: float,
    distances_m: np.ndarray,
) -> RayProfile:
    """Terrain and apparent elevation angle at each distance along one azimuth."""
    lat, lon = destination(observer.lat, observer.lon, azimuth_deg, distances_m)
    terrain, pixel_size = heights_at(products, lat, lon)
    targets = surface_vector(lat, lon, terrain)
    _, elevation, _ = look_angles(observer.position, targets, observer.basis)
    return RayProfile(
        azimuth_deg=float(azimuth_deg),
        distance_m=np.asarray(distances_m, dtype=float),
        lat=lat,
        lon=lon,
        terrain_m=terrain,
        pixel_size_m=pixel_size,
        elevation_deg=elevation,
    )


def horizon_point(profile: RayProfile) -> HorizonPoint:
    """The skyline along this ray: the terrain point seen at the highest angle."""
    i = int(np.nanargmax(profile.elevation_deg))
    return HorizonPoint(
        azimuth_deg=profile.azimuth_deg,
        elevation_deg=float(profile.elevation_deg[i]),
        distance_m=float(profile.distance_m[i]),
        lat=float(profile.lat[i]),
        lon=float(profile.lon[i]),
        terrain_m=float(profile.terrain_m[i]),
        at_max_range=(i == len(profile.distance_m) - 1),
    )


def visible_mask(profile: RayProfile) -> np.ndarray:
    """True for terrain samples the observer can actually see.

    A point is visible if nothing closer appears higher:
        visible[i] = theta[i] >= max(theta[0..i-1])
    """
    el = profile.elevation_deg
    closer_max = np.concatenate([[-np.inf], np.maximum.accumulate(el)[:-1]])
    return el >= closer_max


def side_view(profile: RayProfile, observer: Observer):
    """2D cross-section coordinates in the observer's vertical plane.

    forward_m : horizontal distance ahead of the eye (along the azimuth)
    up_m      : height above (+) or below (-) the eye's horizontal plane

    The Moon's curvature is visible here: far terrain sits far below 0.
    """
    targets = surface_vector(profile.lat, profile.lon, profile.terrain_m)
    rho = targets - observer.position
    ahead = horizontal_direction(observer.lat, observer.lon, profile.azimuth_deg)
    return dot(rho, ahead), dot(rho, observer.basis[2])


def horizon_ray(
    products: list[DemProduct],
    lat: float,
    lon: float,
    azimuth_deg: float,
    height_above_ground_m: float = DEFAULT_OBSERVER_HEIGHT_M,
    max_range_m: float = DEFAULT_MAX_RANGE_M,
    min_step_m: float | None = None,
    relative_step: float = DEFAULT_RELATIVE_STEP,
):
    """Convenience: observer + sampled ray + skyline point in one call.

    min_step_m defaults to half the pixel size of the map at the site.
    Returns (observer, profile, horizon_point).
    """
    observer = make_observer(products, lat, lon, height_above_ground_m)
    if min_step_m is None:
        min_step_m = observer.site_pixel_size_m / 2
    distances = sample_distances(max_range_m, min_step_m, relative_step)
    profile = ray_profile(products, observer, azimuth_deg, distances)
    return observer, profile, horizon_point(profile)

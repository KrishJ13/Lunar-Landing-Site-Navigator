"""Basic facts about the spot you are standing on (component 8).

All heights are relative to the Moon's reference sphere, R = 1737.4 km, the
"mean level" that LOLA heights are measured from. Negative = below mean level.

    ground height     LOLA height at the site
    slope / aspect    from the elevation map gradient at the site:
                        slope  = angle between the ground normal and "up"
                        aspect = compass direction the slope FACES (downhill)
    surroundings      lowest / highest / mean ground within 1 km and 10 km,
                      sampled on rings around the site
    setting           where the site sits relative to its 10 km surroundings:
                        fraction of surrounding ground lower than the site
                        (< 20%: low ground, > 80%: high ground)
"""

from dataclasses import dataclass

import numpy as np

from .dem import DemProduct, best_product, heights_at
from .geometry import destination, dot, enu_basis
from .landscape import terrain_normals

SURROUNDING_RADII_M = (1_000.0, 10_000.0)
_RING_AZIMUTH_STEP_DEG = 5.0
_FLAT_RELIEF_M = 150.0  # less relief than this within 10 km counts as flat
_FLAT_SLOPE_DEG = 0.5  # below this, the slope has no meaningful direction


@dataclass(frozen=True)
class Surroundings:
    radius_m: float
    min_m: float
    max_m: float
    mean_m: float
    max_azimuth_deg: float  # direction of the highest ground
    max_distance_m: float  # how far away it is
    fraction_lower: float  # share of sampled ground lower than the site


@dataclass(frozen=True)
class SiteInfo:
    lat: float
    lon: float
    ground_m: float  # vs mean level (1737.4 km sphere)
    map_name: str
    map_pixel_size_m: float
    slope_deg: float
    aspect_deg: float | None  # None when the ground is essentially level
    surroundings: list[Surroundings]
    setting: str


def sample_surroundings(products: list[DemProduct], lat: float, lon: float, ground_m: float,
                        radius_m: float, step_m: float) -> Surroundings:
    """Ground heights on rings around the site, out to radius_m."""
    radii = np.arange(step_m, radius_m + step_m / 2, step_m)
    azimuths = np.arange(0.0, 360.0, _RING_AZIMUTH_STEP_DEG)
    ring_lat, ring_lon = destination(lat, lon, azimuths[:, None], radii[None, :])
    h, _ = heights_at(products, ring_lat, ring_lon)
    i = np.unravel_index(np.nanargmax(h), h.shape)
    return Surroundings(
        radius_m=radius_m,
        min_m=float(np.nanmin(h)),
        max_m=float(np.nanmax(h)),
        mean_m=float(np.nanmean(h)),
        max_azimuth_deg=float(azimuths[i[0]]),
        max_distance_m=float(radii[i[1]]),
        fraction_lower=float(np.mean(h < ground_m)),
    )


def classify_setting(ground_m: float, wide: Surroundings) -> str:
    relief = wide.max_m - wide.min_m
    if relief < _FLAT_RELIEF_M:
        return "open, nearly flat ground: little terrain within 10 km rises much above or below you"
    if wide.fraction_lower < 0.2:
        return "low ground (a crater floor or basin): most terrain within 10 km is higher than you"
    if wide.fraction_lower > 0.8:
        return "high ground (a ridge, rim or peak): most terrain within 10 km is lower than you"
    return "mid-level ground on a slope: terrain within 10 km rises on some sides and falls on others"


def describe_site(products: list[DemProduct], lat: float, lon: float) -> SiteInfo:
    site_map = best_product(products, lat, lon)
    ground = site_map.height_m(lat, lon)
    pixel = site_map.pixel_size_m

    normal = terrain_normals(products, np.array([lat]), np.array([lon]), pixel)[0]
    east, north, up = enu_basis(lat, lon)
    slope = float(np.degrees(np.arccos(np.clip(dot(normal, up), -1.0, 1.0))))
    # The normal leans towards the downhill side, i.e. the way the slope faces.
    aspect = float(np.mod(np.degrees(np.arctan2(dot(normal, east), dot(normal, north))), 360.0))

    surroundings = [
        # About half a map pixel between rings, but always at least 4 rings
        # (with a coarse map, the 1 km area is smaller than one pixel).
        sample_surroundings(products, lat, lon, ground, r, step_m=min(max(pixel / 2, r / 40), r / 4))
        for r in SURROUNDING_RADII_M
    ]
    return SiteInfo(
        lat=lat,
        lon=lon,
        ground_m=ground,
        map_name=site_map.name,
        map_pixel_size_m=pixel,
        slope_deg=slope,
        aspect_deg=aspect if slope >= _FLAT_SLOPE_DEG else None,
        surroundings=surroundings,
        setting=classify_setting(ground, surroundings[-1]),
    )

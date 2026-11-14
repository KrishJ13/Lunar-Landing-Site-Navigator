"""Request and response shapes for the horizon API (component 5).

The response is column-oriented: each per-azimuth quantity is one array, all
the same length and in the same azimuth order. That keeps the payload small
and maps directly onto plotting the panorama.

Units are in the field names (_deg, _m, _km) so nothing has to be guessed.
"""

from pydantic import BaseModel, Field, field_validator

from ..horizon import DEFAULT_MAX_RANGE_M, DEFAULT_OBSERVER_HEIGHT_M
from ..skyline import DEFAULT_AZIMUTH_STEP_DEG

MODEL_VERSION = "horizon-v1"


class HorizonRequest(BaseModel):
    lat: float = Field(..., ge=-90, le=90, description="Site latitude, degrees (planetocentric)")
    lon: float = Field(..., ge=-360, le=360, description="Site longitude, degrees EAST-positive; any range")
    observer_heights_m: list[float] = Field(
        default=[DEFAULT_OBSERVER_HEIGHT_M],
        min_length=1,
        max_length=5,
        description="Eye/mast heights above the ground, metres (one skyline each)",
    )
    azimuth_step_deg: float = Field(DEFAULT_AZIMUTH_STEP_DEG, ge=0.1, le=10)
    max_range_km: float = Field(DEFAULT_MAX_RANGE_M / 1000, gt=1, le=500)

    @field_validator("observer_heights_m")
    @classmethod
    def _heights_in_range(cls, heights: list[float]) -> list[float]:
        for h in heights:
            if not 0 <= h <= 1000:
                raise ValueError("observer heights must be between 0 and 1000 m")
        return heights


class MapInfo(BaseModel):
    name: str
    pixel_size_m: float


class Site(BaseModel):
    lat: float
    lon: float  # east-positive, normalised to [0, 360)
    ground_m: float  # terrain height above the 1737.4 km reference sphere
    map: MapInfo


class Skyline(BaseModel):
    """The 360 deg skyline for one observer height. Arrays share azimuth order."""

    observer_height_m: float
    eye_m: float  # ground_m + observer_height_m
    smooth_horizon_dip_deg: float  # where the horizon would be on a perfectly smooth Moon
    azimuth_deg: list[float]
    elevation_deg: list[float]  # skyline angle above the horizontal plane
    distance_km: list[float]  # to the terrain forming the skyline
    terrain_m: list[float]  # height of that terrain
    skyline_lat: list[float]
    skyline_lon: list[float]
    map_pixel_size_m: list[float]  # elevation map resolution at that terrain
    at_max_range: list[bool]  # True: skyline may lie beyond max_range_km


class Settings(BaseModel):
    azimuth_step_deg: float
    max_range_km: float
    min_step_m: float
    relative_step: float


class Meta(BaseModel):
    model_version: str = MODEL_VERSION
    frame: str = "MOON_ME (Mean Earth / Polar Axis, as used by LOLA and JPL Horizons)"
    reference_radius_km: float = 1737.4
    azimuth_convention: str = "degrees clockwise from local north (at a pole: from the meridian of the given lon)"
    elevation_convention: str = "degrees above the local horizontal plane (perpendicular to the radial up direction)"
    data_source: str = "NASA LRO LOLA gridded elevation maps (PDS Geosciences Node, LRO-L-LOLA-4-GDR-V1.0)"
    maps_loaded: list[MapInfo]


class HorizonResponse(BaseModel):
    site: Site
    settings: Settings
    skylines: list[Skyline]
    meta: Meta


class Health(BaseModel):
    status: str
    maps_loaded: list[MapInfo]

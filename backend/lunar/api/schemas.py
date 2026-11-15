"""Request and response shapes for the horizon API (component 5).

The response is column-oriented: each per-azimuth quantity is one array, all
the same length and in the same azimuth order. That keeps the payload small
and maps directly onto plotting the panorama.

Units are in the field names (_deg, _m, _km) so nothing has to be guessed.
"""

from typing import Literal

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


# ---------- first-person view (one eye height, skyline + visible landscape) ----------

EYE_HEIGHT_LIMIT_M = 100.0


class ViewRequest(BaseModel):
    lat: float = Field(..., ge=-90, le=90, description="Site latitude, degrees (planetocentric)")
    lon: float = Field(..., ge=-360, le=360, description="Site longitude, degrees EAST-positive; any range")
    observer_height_m: float = Field(
        1.8, ge=0, le=EYE_HEIGHT_LIMIT_M, description="Eye height above the ground, metres (1.8 = standing astronaut)"
    )
    azimuth_step_deg: float = Field(DEFAULT_AZIMUTH_STEP_DEG, ge=0.1, le=10)
    max_range_km: float = Field(DEFAULT_MAX_RANGE_M / 1000, gt=1, le=500)


class SmoothHorizon(BaseModel):
    """How far you could see on a perfectly smooth Moon (and Earth, for comparison).

    line_of_sight_m = sqrt(h (2R + h)), dip_deg = acos(R / (R + h)).
    """

    radius_m: float
    line_of_sight_m: float
    surface_distance_m: float
    dip_deg: float  # how far below eye level the smooth horizon sits (positive number)
    earth_line_of_sight_m: float  # same eye height on Earth (R = 6371 km), for comparison


class LandscapeData(BaseModel):
    """Visible terrain below the skyline, one strip per azimuth (bottom to top).

    Each segment: [el_low_deg, el_high_deg, near_km, far_km, shade, edge, height_m]
      near/far_km: terrain at el_low is near_km away, at el_high far_km away
      shade:       0..1 brightness from slope (fixed viewer-relative light, not sunlight)
      edge:        1 if the segment is terrain emerging from behind a nearer ridge
      height_m:    terrain height at the segment top, vs the Moon's mean level
    """

    azimuth_deg: list[float]
    segment_fields: list[str]
    segments: list[list[list[float]]]
    # Per azimuth: elevation where the Moon's mean level (height 0) would appear
    # at the skyline's distance; skyline above it = terrain above mean level.
    mean_level_elevation_deg: list[float]


class SurroundingsInfo(BaseModel):
    radius_m: float
    min_m: float
    max_m: float
    mean_m: float
    max_azimuth_deg: float
    max_distance_m: float
    fraction_lower: float  # share of surrounding ground lower than where you stand


class SiteInfoData(BaseModel):
    """Where you are standing. Heights are vs the Moon's mean level (1737.4 km sphere)."""

    ground_m: float
    eye_m: float
    slope_deg: float
    aspect_deg: float | None  # compass direction the ground slopes down towards; None if level
    surroundings: list[SurroundingsInfo]  # within 1 km and 10 km
    setting: str


class ViewResponse(BaseModel):
    site: Site
    site_info: SiteInfoData
    settings: Settings
    smooth_horizon: SmoothHorizon
    skyline: Skyline
    landscape: LandscapeData
    meta: Meta


# ---------- ridgeline reconstruction (for the layered 2D renderer) ----------


class RidgesRequest(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-360, le=360, description="degrees EAST-positive; any range")
    observer_height_m: float = Field(1.8, ge=0, le=EYE_HEIGHT_LIMIT_M)
    azimuth_step_deg: float = Field(0.25, ge=0.05, le=2)
    max_range_km: float = Field(DEFAULT_MAX_RANGE_M / 1000, gt=1, le=500)


class SkylineSamples(BaseModel):
    """The skyline in every direction (the farthest visible crest)."""

    azimuth_deg: list[float]
    elevation_deg: list[float]
    distance_km: list[float]
    height_m: list[float]


class RidgelineData(BaseModel):
    """One ridge or mountain crest seen across neighbouring directions.

    Arrays share point order. azimuth_deg is unwrapped (increases along the
    line and may exceed 360 where it crosses north); use it modulo 360.
    """

    median_distance_km: float
    azimuth_deg: list[float]
    elevation_deg: list[float]
    distance_km: list[float]
    height_m: list[float]
    lat: list[float]
    lon: list[float]
    skyline: list[bool]


class PeakData(BaseModel):
    azimuth_deg: float
    elevation_deg: float
    distance_km: float
    height_m: float  # vs the Moon's mean level
    height_above_eye_m: float
    lat: float
    lon: float
    on_skyline: bool
    ridgeline: int  # index into `ridgelines`


class VisibleProfiles(BaseModel):
    """Per direction, the distance of the visible terrain at each elevation
    angle, bottom to top: points [elevation_deg, distance_km, behind_ridge].
    Between two points, distance changes smoothly (interpolate in log-distance)
    unless the upper point has behind_ridge = 1 (terrain emerging behind a
    nearer crest, so the distance jumps there)."""

    azimuth_deg: list[float]
    fields: list[str] = ["elevation_deg", "distance_km", "behind_ridge"]
    points: list[list[list[float]]]


class RidgesResponse(BaseModel):
    site: Site
    site_info: SiteInfoData
    smooth_horizon: SmoothHorizon
    observer_height_m: float
    azimuth_step_deg: float
    skyline: SkylineSamples
    ridgelines: list[RidgelineData]  # far to near: draw in this order
    peaks: list[PeakData]
    profiles: VisibleProfiles
    meta: Meta


class SiteTerrainRequest(BaseModel):
    """POST /api/site/terrain: site mesh with optional far mesh and ray-cast horizon.
    The response is binary (see lunar.api.terrain_payload)."""

    lat: float = Field(..., ge=-90, le=90, description="Site latitude, degrees (planetocentric)")
    lon: float = Field(..., ge=-360, le=360, description="Site longitude, degrees EAST-positive; any range")
    diameter_km: float = Field(10.0, ge=5, le=50, description="Landing-site diameter, km (5-50, as Moon Explorer)")
    observer_height_m: float = Field(
        1.8, ge=0, le=EYE_HEIGHT_LIMIT_M, description="Eye height above the ground, metres (1.8 = standing astronaut)"
    )
    points_across: int = Field(400, ge=50, le=800, description="Target site-grid points across the diameter")
    far_azimuth_step_deg: float = Field(0.5, ge=0.1, le=5)
    far_relative_step: float = Field(0.01, ge=0.002, le=0.1, description="Far-mesh ring step as a fraction of distance")
    max_range_km: float = Field(DEFAULT_MAX_RANGE_M / 1000, gt=1, le=500)
    include_far_mesh: bool = Field(True, description="Include renderable terrain beyond the landing-site disc")
    include_panorama: bool = Field(False, description="Render visible terrain from the observer's eye")
    elevation_product: Literal["ldem_128", "lola_chain"] | None = Field(
        None, description="Use one LOLA grid or the distance-based LOLA panorama chain")
    include_ray_skyline: bool = Field(
        False, description="Include the ray-cast terrain horizon around the observer")

"""FastAPI application: serve local horizons as JSON (component 5).

Endpoints
    GET  /api/health     which elevation maps are loaded
    POST /api/horizon    360 deg skyline(s) for several eye heights; see schemas.HorizonRequest
    POST /api/view       one eye height: skyline + visible landscape for the
                         first-person view; see schemas.ViewRequest
    POST /api/ridges     one eye height: reconstructed ridgelines and peaks
                         (bicubic surface, refined crests); see schemas.RidgesRequest

Elevation maps are opened once at startup (memory-mapped, so this is cheap)
and shared by all requests.
"""

import os

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from ..config import MOON_RADIUS_M
from ..dem import DemProduct, load_available
from ..dem.projections import wrap_longitude
from ..horizon import DEFAULT_RELATIVE_STEP
from ..geometry import geometric_horizon
from ..landscape import SEGMENT_FIELDS, View, compute_view
from ..ridgelines import find_peaks, link_ridgelines
from ..ridges import compute_crests
from ..site import SiteInfo, describe_site
from ..skyline import HorizonProfile, compute_skyline
from .schemas import (
    Health,
    HorizonRequest,
    HorizonResponse,
    LandscapeData,
    MapInfo,
    Meta,
    PeakData,
    RidgelineData,
    RidgesRequest,
    RidgesResponse,
    Settings,
    Site,
    SiteInfoData,
    Skyline,
    SkylineSamples,
    VisibleProfiles,
    SmoothHorizon,
    SurroundingsInfo,
    ViewRequest,
    ViewResponse,
)

EARTH_RADIUS_M = 6_371_000.0  # mean radius, only for the "same height on Earth" comparison

# Vite's dev server by default; override with a comma-separated list.
DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"


def _map_infos(products: list[DemProduct]) -> list[MapInfo]:
    return [MapInfo(name=p.name, pixel_size_m=p.pixel_size_m) for p in sorted(products, key=lambda p: p.pixel_size_m)]


def _rounded(values: np.ndarray, decimals: int) -> list[float]:
    return np.round(np.asarray(values, dtype=float), decimals).tolist()


def skyline_to_schema(profile: HorizonProfile) -> Skyline:
    """Convert a computed HorizonProfile into the JSON response shape."""
    eye_m = profile.ground_m + profile.height_above_ground_m
    dip = geometric_horizon(profile.height_above_ground_m)["dip_deg"]
    return Skyline(
        observer_height_m=profile.height_above_ground_m,
        eye_m=round(eye_m, 2),
        smooth_horizon_dip_deg=round(-float(dip), 5),
        azimuth_deg=_rounded(profile.azimuth_deg, 4),
        elevation_deg=_rounded(profile.elevation_deg, 4),
        distance_km=_rounded(profile.distance_m / 1000, 3),
        terrain_m=_rounded(profile.terrain_m, 1),
        skyline_lat=_rounded(profile.skyline_lat, 5),
        skyline_lon=_rounded(profile.skyline_lon, 5),
        map_pixel_size_m=_rounded(profile.skyline_pixel_size_m, 2),
        at_max_range=profile.at_max_range.tolist(),
    )


def landscape_to_schema(view: View) -> LandscapeData:
    # decimals per field: el_low, el_high, near_km, far_km, shade, edge, height_m
    rounding = (4, 4, 3, 3, 3, 0, 0)
    segments = [
        [[round(float(v), d) for v, d in zip(row, rounding)] for row in strip]
        for strip in view.landscape.segments
    ]
    return LandscapeData(
        azimuth_deg=_rounded(view.landscape.azimuth_deg, 4),
        segment_fields=list(SEGMENT_FIELDS),
        segments=segments,
        mean_level_elevation_deg=_rounded(view.mean_level_elevation_deg, 4),
    )


def site_info_to_schema(info: SiteInfo, eye_height_m: float) -> SiteInfoData:
    return SiteInfoData(
        ground_m=round(info.ground_m, 1),
        eye_m=round(info.ground_m + eye_height_m, 1),
        slope_deg=round(info.slope_deg, 2),
        aspect_deg=None if info.aspect_deg is None else round(info.aspect_deg, 1),
        surroundings=[
            SurroundingsInfo(
                radius_m=s.radius_m,
                min_m=round(s.min_m, 1),
                max_m=round(s.max_m, 1),
                mean_m=round(s.mean_m, 1),
                max_azimuth_deg=s.max_azimuth_deg,
                max_distance_m=round(s.max_distance_m, 1),
                fraction_lower=round(s.fraction_lower, 3),
            )
            for s in info.surroundings
        ],
        setting=info.setting,
    )


def smooth_horizon(height_m: float) -> SmoothHorizon:
    moon = geometric_horizon(height_m)
    return SmoothHorizon(
        radius_m=MOON_RADIUS_M,
        line_of_sight_m=round(moon["line_of_sight_m"], 2),
        surface_distance_m=round(moon["surface_distance_m"], 2),
        dip_deg=round(moon["dip_deg"], 5),
        earth_line_of_sight_m=round(geometric_horizon(height_m, EARTH_RADIUS_M)["line_of_sight_m"], 2),
    )


def _site(lat: float, lon: float, profile: HorizonProfile) -> Site:
    return Site(
        lat=lat,
        lon=lon,
        ground_m=round(profile.ground_m, 1),
        map=MapInfo(name=profile.site_map_name, pixel_size_m=profile.site_pixel_size_m),
    )


def create_app(products: list[DemProduct] | None = None) -> FastAPI:
    """Build the app. Pass `products` to use specific maps (tests); otherwise
    every downloaded map in the data folder is loaded."""
    app = FastAPI(title="Lunar Landing Site Navigator API", version="0.1.0")
    app.state.products = load_available() if products is None else products

    origins = os.environ.get("LUNAR_CORS_ORIGINS", DEFAULT_CORS_ORIGINS).split(",")
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"], allow_headers=["*"])
    app.add_middleware(GZipMiddleware, minimum_size=1000)  # JSON arrays compress ~5-10x

    @app.get("/api/health", response_model=Health)
    def health() -> Health:
        maps = _map_infos(app.state.products)
        return Health(status="ok" if maps else "no elevation maps loaded", maps_loaded=maps)

    @app.post("/api/horizon", response_model=HorizonResponse)
    def horizon(request: HorizonRequest) -> HorizonResponse:
        products = app.state.products
        if not products:
            raise HTTPException(503, "No elevation maps loaded. Run scripts/fetch_dem.py --tier starter.")

        lon = float(wrap_longitude(request.lon))
        try:
            profiles = compute_skyline(
                products,
                request.lat,
                lon,
                heights_above_ground_m=request.observer_heights_m,
                azimuth_step_deg=request.azimuth_step_deg,
                max_range_m=request.max_range_km * 1000,
            )
        except LookupError as exc:  # no map covers the site
            raise HTTPException(422, str(exc)) from exc

        first = profiles[0]
        return HorizonResponse(
            site=Site(
                lat=request.lat,
                lon=lon,
                ground_m=round(first.ground_m, 1),
                map=MapInfo(name=first.site_map_name, pixel_size_m=first.site_pixel_size_m),
            ),
            settings=Settings(
                azimuth_step_deg=request.azimuth_step_deg,
                max_range_km=request.max_range_km,
                min_step_m=first.site_pixel_size_m / 2,  # compute_skyline's default
                relative_step=DEFAULT_RELATIVE_STEP,
            ),
            skylines=[skyline_to_schema(p) for p in profiles],
            meta=Meta(maps_loaded=_map_infos(products)),
        )

    @app.post("/api/view", response_model=ViewResponse)
    def view(request: ViewRequest) -> ViewResponse:
        products = app.state.products
        if not products:
            raise HTTPException(503, "No elevation maps loaded. Run scripts/fetch_dem.py --tier starter.")

        lon = float(wrap_longitude(request.lon))
        try:
            view = compute_view(
                products,
                request.lat,
                lon,
                height_above_ground_m=request.observer_height_m,
                azimuth_step_deg=request.azimuth_step_deg,
                max_range_m=request.max_range_km * 1000,
            )
            info = describe_site(products, request.lat, lon)
        except LookupError as exc:
            raise HTTPException(422, str(exc)) from exc
        profile = view.skyline

        return ViewResponse(
            site=_site(request.lat, lon, profile),
            site_info=site_info_to_schema(info, request.observer_height_m),
            settings=Settings(
                azimuth_step_deg=request.azimuth_step_deg,
                max_range_km=request.max_range_km,
                min_step_m=profile.site_pixel_size_m / 2,
                relative_step=DEFAULT_RELATIVE_STEP,
            ),
            smooth_horizon=smooth_horizon(request.observer_height_m),
            skyline=skyline_to_schema(profile),
            landscape=landscape_to_schema(view),
            meta=Meta(maps_loaded=_map_infos(products)),
        )

    @app.post("/api/ridges", response_model=RidgesResponse)
    def ridges(request: RidgesRequest) -> RidgesResponse:
        products = app.state.products
        if not products:
            raise HTTPException(503, "No elevation maps loaded. Run scripts/fetch_dem.py --tier starter.")
        lon = float(wrap_longitude(request.lon))
        try:
            view = compute_crests(
                products,
                request.lat,
                lon,
                height_above_ground_m=request.observer_height_m,
                azimuth_step_deg=request.azimuth_step_deg,
                max_range_m=request.max_range_km * 1000,
            )
            info = describe_site(products, request.lat, lon)
        except LookupError as exc:
            raise HTTPException(422, str(exc)) from exc

        lines = link_ridgelines(view)
        observer = view.observer
        sky = [c[-1] for c in view.crests]  # every direction has at least one crest (the skyline)
        return RidgesResponse(
            site=Site(
                lat=request.lat,
                lon=lon,
                ground_m=round(observer.ground_m, 1),
                map=MapInfo(name=observer.site_map_name, pixel_size_m=observer.site_pixel_size_m),
            ),
            site_info=site_info_to_schema(info, request.observer_height_m),
            smooth_horizon=smooth_horizon(request.observer_height_m),
            observer_height_m=request.observer_height_m,
            azimuth_step_deg=request.azimuth_step_deg,
            skyline=SkylineSamples(
                azimuth_deg=_rounded(view.azimuth_deg, 4),
                elevation_deg=_rounded([c[1] for c in sky], 4),
                distance_km=_rounded([c[0] / 1000 for c in sky], 4),
                height_m=_rounded([c[2] for c in sky], 1),
            ),
            ridgelines=[
                RidgelineData(
                    median_distance_km=round(r.median_distance_m / 1000, 4),
                    azimuth_deg=_rounded(r.azimuth_deg, 4),
                    elevation_deg=_rounded(r.elevation_deg, 4),
                    distance_km=_rounded(np.asarray(r.distance_m) / 1000, 4),
                    height_m=_rounded(r.height_m, 1),
                    lat=_rounded(r.lat, 5),
                    lon=_rounded(r.lon, 5),
                    skyline=r.skyline,
                )
                for r in lines
            ],
            peaks=[
                PeakData(
                    azimuth_deg=round(p.azimuth_deg, 3),
                    elevation_deg=round(p.elevation_deg, 4),
                    distance_km=round(p.distance_m / 1000, 4),
                    height_m=round(p.height_m, 1),
                    height_above_eye_m=round(p.height_m - (observer.ground_m + request.observer_height_m), 1),
                    lat=round(p.lat, 5),
                    lon=round(p.lon, 5),
                    on_skyline=p.on_skyline,
                    ridgeline=p.ridgeline,
                )
                for p in find_peaks(lines)
            ],
            profiles=VisibleProfiles(
                azimuth_deg=_rounded(view.azimuth_deg, 4),
                points=[
                    [[round(float(e), 4), round(float(d) / 1000, 4), int(f)] for e, d, f in prof]
                    for prof in view.profiles
                ],
            ),
            meta=Meta(maps_loaded=_map_infos(products)),
        )

    return app


# The app uvicorn serves. Opening maps is cheap (memory-mapped), and an empty
# data folder still starts fine: /api/health then reports no maps loaded.
app = create_app()

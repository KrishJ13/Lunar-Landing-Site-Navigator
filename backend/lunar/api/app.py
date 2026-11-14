"""FastAPI application: serve local horizons as JSON (component 5).

Endpoints
    GET  /api/health     which elevation maps are loaded
    POST /api/horizon    360 deg skyline(s) for a site; see schemas.HorizonRequest

Elevation maps are opened once at startup (memory-mapped, so this is cheap)
and shared by all requests.
"""

import os

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from ..config import MOON_RADIUS_M
from ..dem import DemProduct, load_available
from ..dem.projections import wrap_longitude
from ..horizon import DEFAULT_RELATIVE_STEP
from ..skyline import HorizonProfile, compute_skyline
from .schemas import (
    Health,
    HorizonRequest,
    HorizonResponse,
    MapInfo,
    Meta,
    Settings,
    Site,
    Skyline,
)

# Vite's dev server by default; override with a comma-separated list.
DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"


def _map_infos(products: list[DemProduct]) -> list[MapInfo]:
    return [MapInfo(name=p.name, pixel_size_m=p.pixel_size_m) for p in sorted(products, key=lambda p: p.pixel_size_m)]


def _rounded(values: np.ndarray, decimals: int) -> list[float]:
    return np.round(np.asarray(values, dtype=float), decimals).tolist()


def skyline_to_schema(profile: HorizonProfile) -> Skyline:
    """Convert a computed HorizonProfile into the JSON response shape."""
    eye_m = profile.ground_m + profile.height_above_ground_m
    dip = np.degrees(np.arccos(MOON_RADIUS_M / (MOON_RADIUS_M + profile.height_above_ground_m)))
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


def create_app(products: list[DemProduct] | None = None) -> FastAPI:
    """Build the app. Pass `products` to use specific maps (tests); otherwise
    every downloaded map in the data folder is loaded."""
    app = FastAPI(title="Lunar Landing Site Navigator API", version="0.1.0")
    app.state.products = load_available() if products is None else products

    origins = os.environ.get("LUNAR_CORS_ORIGINS", DEFAULT_CORS_ORIGINS).split(",")
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"], allow_headers=["*"])

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

    return app


# The app uvicorn serves. Opening maps is cheap (memory-mapped), and an empty
# data folder still starts fine: /api/health then reports no maps loaded.
app = create_app()

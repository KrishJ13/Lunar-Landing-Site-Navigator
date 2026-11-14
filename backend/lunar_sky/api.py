"""FastAPI interface over lunar_sky.positions. Run: uvicorn lunar_sky.api:app (from backend/)."""
import logging
import os
import threading
from contextlib import asynccontextmanager
from typing import Annotated, Any

import spiceypy as sp
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import positions
from .kernels import KDIR, LOAD_ORDER, load_kernels

log = logging.getLogger("lunar_sky.api")
DEFAULT_ORIGINS = "http://localhost:5173"
# SPICE's kernel pool is process-global and CSPICE is not thread-safe: serialise every call.
_spice_lock = threading.Lock()


class Health(BaseModel):
    status: str  # "ok" | "degraded"
    kernels_ready: bool
    detail: str | None = None


class Site(BaseModel):
    latitude_deg: float
    longitude_deg_east: float
    elevation_m: float


class Body(BaseModel):
    azimuth_deg: float
    elevation_deg: float
    distance_km: float
    angular_radius_deg: float


class PositionsResponse(BaseModel):
    site: Site
    timestamp_utc: str
    sun: Body
    earth: Body
    model: dict[str, Any]


class ErrorResponse(BaseModel):
    error: str
    detail: str


def _error(status: int, error: str, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": error, "detail": detail})


def _load() -> tuple[bool, str | None]:
    missing = [n for n in LOAD_ORDER if not (KDIR / n).is_file()]
    if missing:
        return False, "missing kernel files: " + ", ".join(missing)
    try:
        with _spice_lock:
            load_kernels()
            if sp.ktotal("ALL") != len(LOAD_ORDER):
                return False, "unexpected number of loaded kernels"
    except Exception as e:  # SpiceyError or OS error: report, don't crash startup
        return False, f"kernel load failed: {e}"
    return True, None


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.kernels_ready, app.state.kernel_detail = _load()
    if not app.state.kernels_ready:
        log.error("SPICE kernels unavailable: %s", app.state.kernel_detail)
    yield
    with _spice_lock:
        sp.kclear()
    app.state.kernels_ready = False


app = FastAPI(title="Lunar Skyline API", version="0.1.0", lifespan=lifespan, docs_url="/docs")
app.state.kernels_ready, app.state.kernel_detail = False, "not started"

_origins = os.environ.get("LUNAR_SKY_CORS_ORIGINS", DEFAULT_ORIGINS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins.split(",") if o.strip()],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def _validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    msgs = "; ".join(".".join(str(p) for p in e["loc"][1:]) + ": " + e["msg"] for e in exc.errors())
    return _error(422, "validation_error", msgs)


@app.exception_handler(Exception)
async def _unexpected_handler(_: Request, exc: Exception) -> JSONResponse:
    log.exception("unhandled error", exc_info=exc)
    return _error(500, "internal_error", "Unexpected internal error.")


@app.get("/api/v1/health", response_model=Health)
def health() -> Health:
    ok = app.state.kernels_ready
    return Health(status="ok" if ok else "degraded", kernels_ready=ok, detail=app.state.kernel_detail)


@app.get(
    "/api/v1/positions",
    response_model=PositionsResponse,
    responses={
        400: {"model": ErrorResponse, "description": "Valid inputs but SPICE could not evaluate them (e.g. date outside kernel coverage)."},
        422: {"model": ErrorResponse, "description": "Invalid or non-finite input, or timestamp not explicit UTC."},
        503: {"model": ErrorResponse, "description": "SPICE kernels missing or unusable."},
    },
)
def get_positions(
    lat: Annotated[float, Query(ge=-90, le=90, allow_inf_nan=False, description="Planetocentric latitude, degrees")],
    lon: Annotated[float, Query(ge=-360, le=360, allow_inf_nan=False, description="East-positive longitude, degrees; normalised to [0, 360)")],
    timestamp_utc: Annotated[str, Query(description="ISO 8601 with explicit UTC (Z or +00:00)")],
    elevation_m: Annotated[float, Query(ge=positions.H_MIN_M, le=positions.H_MAX_M, allow_inf_nan=False, description="Metres above the 1737.4 km sphere")] = 0.0,
):
    if not app.state.kernels_ready:
        return _error(503, "kernels_unavailable", app.state.kernel_detail or "SPICE kernels unavailable.")
    try:
        positions._validate(lat, lon, elevation_m, timestamp_utc)
    except ValueError as e:
        return _error(422, "validation_error", str(e))
    try:
        with _spice_lock:
            return positions.calculate_positions(lat, lon, elevation_m, timestamp_utc)
    except ValueError as e:  # remaining ValueError = SPICE evaluation failure
        return _error(400, "ephemeris_unavailable", str(e))

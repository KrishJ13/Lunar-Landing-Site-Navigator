"""FastAPI interface over lunar_sky.positions. Run: uvicorn lunar_sky.api:app (from backend/)."""
import logging
import os
import threading
from contextlib import asynccontextmanager
from typing import Annotated, Any

import spiceypy as sp
from fastapi import APIRouter, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import positions
from .globe import globe_geometry
from .kernels import KDIR, LOAD_ORDER, load_kernels

log = logging.getLogger("lunar_sky.api")
DEFAULT_ORIGINS = "http://localhost:5173"
# SPICE's kernel pool is process-global and CSPICE is not thread-safe: serialise every call.
_spice_lock = threading.Lock()
# A series holds the lock for at most this many samples at a time, so other requests interleave.
SERIES_CHUNK = 50


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


class SeriesSample(BaseModel):
    timestamp_utc: str
    sun: Body
    earth: Body


class SeriesResponse(BaseModel):
    site: Site
    start_utc: str
    end_utc: str  # requested end (start + hours); a sample exists there only if end_included
    end_included: bool
    last_sample_utc: str
    hours: float
    step_minutes: float
    sample_count: int
    samples: list[SeriesSample]
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
    app.state.coverage = None
    if not app.state.kernels_ready:
        log.error("SPICE kernels unavailable: %s", app.state.kernel_detail)
    yield
    with _spice_lock:
        sp.kclear()
    app.state.kernels_ready = False


# Routes live on a router so the unified service (lunar_skyline.app) can mount them next to the terrain API.
router = APIRouter()

app = FastAPI(title="Lunar Skyline API", version="0.1.0", lifespan=lifespan, docs_url="/docs")
app.state.kernels_ready, app.state.kernel_detail = False, "not started"

_origins = os.environ.get("LUNAR_SKY_CORS_ORIGINS", DEFAULT_ORIGINS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins.split(",") if o.strip()],
    allow_methods=["GET"],
    allow_headers=["*"],
)


async def validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    msgs = "; ".join(".".join(str(p) for p in e["loc"][1:]) + ": " + e["msg"] for e in exc.errors())
    return _error(422, "validation_error", msgs)


async def unexpected_handler(_: Request, exc: Exception) -> JSONResponse:
    log.exception("unhandled error", exc_info=exc)
    return _error(500, "internal_error", "Unexpected internal error.")


@router.get("/api/v1/health", response_model=Health)
def health(request: Request) -> Health:
    st = request.app.state
    ok = st.kernels_ready
    return Health(status="ok" if ok else "degraded", kernels_ready=ok, detail=st.kernel_detail)


@router.get("/api/v1/moon-globe")
def get_moon_globe(request: Request, timestamp_utc: str):
    if not request.app.state.kernels_ready:
        return _error(503, "kernels_unavailable", request.app.state.kernel_detail or "SPICE kernels unavailable.")
    try:
        instant = positions._validate(0, 0, 0, timestamp_utc)
    except ValueError as exc:
        return _error(422, "validation_error", str(exc))
    try:
        with _spice_lock:
            return globe_geometry(instant)
    except sp.utils.exceptions.SpiceyError:
        return _error(400, "ephemeris_unavailable", "Date is outside the installed ephemeris coverage.")


@router.get(
    "/api/v1/positions",
    response_model=PositionsResponse,
    responses={
        400: {"model": ErrorResponse, "description": "Valid inputs but SPICE could not evaluate them (e.g. date outside kernel coverage)."},
        422: {"model": ErrorResponse, "description": "Invalid or non-finite input, or timestamp not explicit UTC."},
        503: {"model": ErrorResponse, "description": "SPICE kernels missing or unusable."},
    },
)
def get_positions(
    request: Request,
    lat: Annotated[float, Query(ge=-90, le=90, allow_inf_nan=False, description="Planetocentric latitude, degrees")],
    lon: Annotated[float, Query(ge=-360, le=360, allow_inf_nan=False, description="East-positive longitude, degrees; normalised to [0, 360)")],
    timestamp_utc: Annotated[str, Query(description="ISO 8601 with explicit UTC (Z or +00:00)")],
    elevation_m: Annotated[float, Query(ge=positions.H_MIN_M, le=positions.H_MAX_M, allow_inf_nan=False, description="Metres above the 1737.4 km sphere")] = 0.0,
):
    if not request.app.state.kernels_ready:
        return _error(503, "kernels_unavailable", request.app.state.kernel_detail or "SPICE kernels unavailable.")
    try:
        positions._validate(lat, lon, elevation_m, timestamp_utc)
    except ValueError as e:
        return _error(422, "validation_error", str(e))
    try:
        with _spice_lock:
            return positions.calculate_positions(lat, lon, elevation_m, timestamp_utc)
    except ValueError as e:  # remaining ValueError = SPICE evaluation failure
        return _error(400, "ephemeris_unavailable", str(e))


@router.get(
    "/api/v1/positions/series",
    response_model=SeriesResponse,
    summary="Sun/Earth apparent positions at uniform UTC steps",
    description=(
        "Same calculation and conventions as `/api/v1/positions`, evaluated at "
        "`t_k = start_utc + k*step_minutes`, k = 0..K, K = floor(hours*60/step_minutes). "
        "The start is always included. The end (`start_utc + hours`, returned as `end_utc`) is "
        "included only when it falls exactly on a step (`end_included`); otherwise the last sample "
        "is the last one before it (`last_sample_utc`). `sample_count = K + 1` must not exceed 1000 "
        "(else 422). All sample times are checked against kernel coverage before any evaluation; if "
        "any sample cannot be computed the whole request fails (no partial results). "
        "`model` is returned once, not per sample. No terrain occlusion is modelled."
    ),
    responses={
        400: {"model": ErrorResponse, "description": "Span outside kernel coverage, or SPICE failed for a sample."},
        422: {"model": ErrorResponse, "description": "Invalid input, non-UTC start, hours/step out of range, or more than 1000 samples."},
        503: {"model": ErrorResponse, "description": "SPICE kernels missing or unusable."},
    },
)
def get_positions_series(
    request: Request,
    lat: Annotated[float, Query(ge=-90, le=90, allow_inf_nan=False, description="Planetocentric latitude, degrees")],
    lon: Annotated[float, Query(ge=-360, le=360, allow_inf_nan=False, description="East-positive longitude, degrees; normalised to [0, 360)")],
    start_utc: Annotated[str, Query(description="ISO 8601 with explicit UTC (Z or +00:00)")],
    hours: Annotated[float, Query(gt=0, le=positions.MAX_HOURS, allow_inf_nan=False, description="Time span in hours, > 0 and <= 168")],
    step_minutes: Annotated[float, Query(ge=positions.MIN_STEP_MIN, le=positions.MAX_STEP_MIN, allow_inf_nan=False, description="Sample interval in minutes, 10..360")],
    elevation_m: Annotated[float, Query(ge=positions.H_MIN_M, le=positions.H_MAX_M, allow_inf_nan=False, description="Metres above the 1737.4 km sphere")] = 0.0,
):
    if not request.app.state.kernels_ready:
        return _error(503, "kernels_unavailable", request.app.state.kernel_detail or "SPICE kernels unavailable.")
    try:
        start, dts = positions.plan_series(lat, lon, elevation_m, start_utc, hours, step_minutes)
    except ValueError as e:
        return _error(422, "validation_error", str(e))
    site = positions.series_site(lat, lon, elevation_m)
    try:
        with _spice_lock:  # coverage + epoch conversion: cheap, done before any evaluation
            if request.app.state.coverage is None:
                request.app.state.coverage = positions.coverage_windows()
            ets = positions.series_epochs(dts)
            positions.check_coverage(ets, request.app.state.coverage)
        samples = []
        for i in range(0, len(dts), SERIES_CHUNK):
            with _spice_lock:  # released between chunks so one long series can't starve others
                samples += positions.evaluate_series_chunk(site, dts[i:i + SERIES_CHUNK], ets[i:i + SERIES_CHUNK])
    except ValueError as e:
        return _error(400, "ephemeris_unavailable", str(e))
    end = positions.series_end(start, hours)
    return {
        "site": {"latitude_deg": lat, "longitude_deg_east": lon, "elevation_m": elevation_m},
        "start_utc": samples[0]["timestamp_utc"],
        "end_utc": positions._fmt(end),
        "end_included": dts[-1] == end,
        "last_sample_utc": samples[-1]["timestamp_utc"],
        "hours": hours,
        "step_minutes": step_minutes,
        "sample_count": len(samples),
        "samples": samples,
        "model": positions.model_metadata(),
    }


app.include_router(router)
app.add_exception_handler(RequestValidationError, validation_handler)
app.add_exception_handler(Exception, unexpected_handler)

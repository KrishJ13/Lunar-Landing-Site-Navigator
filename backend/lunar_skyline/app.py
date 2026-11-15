"""One FastAPI app serving both scientific modules. Run from backend/:

    python -m uvicorn lunar_skyline.app:app --host 127.0.0.1 --port 8000

Terrain routes (/api/health, /api/horizon, /api/view, /api/ridges) and sky routes (/api/v1/*) keep
their original contracts. Validation/500 handlers are path-scoped so each family keeps its own
error format: /api/v1/* uses {"error","detail"}, everything else uses FastAPI's defaults.
Either subsystem may be unavailable (no kernels / no DEM) without taking down the other.
"""
import os

from fastapi import FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import PlainTextResponse

from lunar.api.app import create_app as create_terrain_app
from lunar.dem import DemProduct
from lunar_sky import api as sky

_SKY_PREFIX = "/api/v1/"


async def _validation(request: Request, exc: RequestValidationError):
    if request.url.path.startswith(_SKY_PREFIX):
        return await sky.validation_handler(request, exc)
    return await request_validation_exception_handler(request, exc)


async def _unexpected(request: Request, exc: Exception):
    if request.url.path.startswith(_SKY_PREFIX):
        return await sky.unexpected_handler(request, exc)
    sky.log.exception("unhandled error", exc_info=exc)
    return PlainTextResponse("Internal Server Error", status_code=500)


def create_app(products: list[DemProduct] | None = None) -> FastAPI:
    # Terrain app owns CORS (GET+POST); fold the sky origins variable into it.
    if "LUNAR_SKY_CORS_ORIGINS" in os.environ:
        merged = [os.environ.get("LUNAR_CORS_ORIGINS", ""), os.environ["LUNAR_SKY_CORS_ORIGINS"]]
        os.environ["LUNAR_CORS_ORIGINS"] = ",".join(o for o in merged if o)
    app = create_terrain_app(products)
    app.title = "Lunar Skyline API"
    app.state.kernels_ready, app.state.kernel_detail = False, "not started"
    app.state.coverage = None
    app.router.lifespan_context = sky.lifespan  # loads SPICE kernels once at startup
    app.include_router(sky.router)
    app.add_exception_handler(RequestValidationError, _validation)
    app.add_exception_handler(Exception, _unexpected)
    return app


app = create_app()

"""FastAPI application: serve local horizons as JSON (component 5).

Endpoints
    GET  /api/health     which elevation maps are loaded
    POST /api/horizon    360 deg skyline(s) for several eye heights; see schemas.HorizonRequest
    POST /api/view       one eye height: skyline + visible landscape for the
                         first-person view; see schemas.ViewRequest
    POST /api/ridges     one eye height: reconstructed ridgelines and peaks
                         (bicubic surface, refined crests); see schemas.RidgesRequest
    POST /api/site/terrain  site mesh with optional far mesh and ray-cast horizon
                         (binary; see lunar.terrain and terrain_payload)

Elevation maps are opened once at startup (memory-mapped, so this is cheap)
and shared by all requests.
"""

import os
import threading
import time
from collections import OrderedDict

import numpy as np
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from ..config import DEM_DIR, MOON_RADIUS_M
from ..dem import DemProduct, load_available
from ..dem.remote import LazyRemoteProduct, load_remote, remote_specs
from ..dem.projections import wrap_longitude
from ..horizon import DEFAULT_RELATIVE_STEP
from ..geometry import geometric_horizon
from ..landscape import SEGMENT_FIELDS, View, compute_view
from ..panorama import SPIKE_CORRECTION_STRENGTH
from ..ridgelines import find_peaks, link_ridgelines
from ..ridges import compute_crests
from ..site import SiteInfo, describe_site
from ..skyline import HorizonProfile, compute_skyline
from ..lola_chain import best_maps
from ..terrain import FAR_TARGET_M, build_site_terrain, maps_used
from . import terrain_payload
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
    SiteTerrainRequest,
    SiteWindowsRequest,
    IlluminationRequest,
    ShadowFieldRequest,
    ViewRequest,
    ViewResponse,
)

TERRAIN_CACHE_SIZE = 8  # recent site packages kept in memory (each a few MB)
LOG16_MAX_M = 400_000.0  # panorama_distance_log16: q = 65535 at 400 km

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
    every downloaded map in the data folder is loaded.

    /api/site/terrain additionally reads maps from the PDS server on demand
    (lunar.dem.remote; set LUNAR_REMOTE_DEM=0 to turn that off). The older
    endpoints keep using local maps only: they take the finest map for every
    sample, which with remote 5 m maps would mean fetching them along 300 km rays.
    """
    app = FastAPI(title="Lunar Landing Site Navigator API", version="0.1.0")
    app.state.products = load_available() if products is None else products
    use_remote = products is None and os.environ.get("LUNAR_REMOTE_DEM", "1") != "0"
    app.state.terrain_products = list(app.state.products) + (load_remote(DEM_DIR / "cache") if use_remote else [])
    app.state.lola_chain_products = list(app.state.terrain_products)
    if use_remote:
        app.state.lola_chain_products.extend(
            LazyRemoteProduct(spec, DEM_DIR / "cache")
            for spec in remote_specs() if spec.name in {"ldem_512", "ldem_256"}
        )
    app.state.terrain_cache = OrderedDict()
    from ..horizon_tiles import HorizonTiles
    app.state.horizon_tiles = (HorizonTiles(app.state.terrain_products, DEM_DIR / "cache" if products is None else None)
                               if app.state.terrain_products else None)
    terrain_lock = threading.Lock()

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

    @app.post(
        "/api/site/terrain",
        response_class=Response,
        responses={200: {"content": {"application/octet-stream": {}},
                         "description": "Binary terrain payload (lunar.api.terrain_payload)"}},
    )
    def site_terrain(request: SiteTerrainRequest) -> Response:
        products = app.state.terrain_products
        use_chain = request.elevation_product in ("lola_chain", "best")
        chain_maps = best_maps(request.lat) if request.elevation_product == "best" else None
        if use_chain:
            if not request.include_panorama or request.include_far_mesh:
                raise HTTPException(422, "The map chain requires a panorama without the legacy far mesh.")
            products = app.state.lola_chain_products
        elif request.elevation_product is not None:
            matches = [product for product in products if product.name == request.elevation_product]
            if not matches:
                raise HTTPException(503, "LOLA LDEM_128 is unavailable. Load the local grid or enable remote DEM access.")
            # A downloaded file and its remote reader can both be registered.
            products = [min(matches, key=lambda product: bool(getattr(product, "is_remote", False)))]
        if not products:
            raise HTTPException(503, "No elevation maps available.")
        lon = float(wrap_longitude(request.lon))
        key = (round(request.lat, 6), round(lon, 6), request.diameter_km, request.observer_height_m,
               request.points_across, request.far_azimuth_step_deg, request.far_relative_step, request.max_range_km,
               request.include_far_mesh, request.include_ray_skyline, request.include_panorama,
               request.elevation_product, request.distance_log16, request.despike, request.surround_km)
        with terrain_lock:
            cached = app.state.terrain_cache.get(key)
            if cached is not None:
                app.state.terrain_cache.move_to_end(key)
                return Response(cached, media_type="application/octet-stream")
        try:
            t = build_site_terrain(
                products, request.lat, lon, request.diameter_km * 1000,
                eye_height_m=request.observer_height_m,
                points_across=request.points_across,
                far_azimuth_step_deg=request.far_azimuth_step_deg,
                far_relative_step=request.far_relative_step,
                max_range_m=request.max_range_km * 1000,
                with_far_mesh=request.include_far_mesh,
                with_ray_skyline=request.include_ray_skyline,
                with_panorama=request.include_panorama,
                with_lola_chain=use_chain,
                chain_maps=chain_maps,
                despike_grids=request.despike,
                surround_m=request.surround_km * 1000,
            )
        except LookupError as exc:
            raise HTTPException(422, str(exc)) from exc
        except OSError as exc:  # remote map server unreachable
            raise HTTPException(503, f"Elevation map server unavailable: {exc}") from exc
        arrays = {
            "site_xy_m": t.site_xy_m.astype(np.float32),
            "site_enu_m": t.site_enu.astype(np.float32),
            "site_height_m": t.site_height_m.astype(np.float32),
            "site_in_disc": t.in_disc().astype(np.uint8),
        }
        if t.surround is not None:
            arrays.update(surround_xy_m=t.surround["xy_m"].astype(np.float32),
                          surround_enu_m=t.surround["enu"].astype(np.float32),
                          surround_height_m=t.surround["height_m"].astype(np.float32))
        if request.include_far_mesh:
            arrays.update(
                far_azimuth_deg=t.far_azimuth_deg.astype(np.float32),
                far_distance_m=t.far_distance_m.astype(np.float32),
                far_enu_m=t.far_enu.astype(np.float32),
                far_height_m=t.far_height_m.astype(np.float32),
            )
        if t.ray_skyline_deg is not None:
            arrays["ray_skyline_azimuth_deg"] = t.far_azimuth_deg.astype(np.float32)
            arrays["ray_skyline_deg"] = t.ray_skyline_deg.astype(np.float32)
            arrays["ray_skyline_distance_m"] = t.ray_skyline_distance_m.astype(np.float32)
        if t.panorama_shade is not None:
            arrays["panorama_shade"] = t.panorama_shade
            arrays["panorama_normal"] = t.panorama_normal
            arrays["panorama_distance_m"] = t.panorama_distance.astype(np.float16)  # V2: used within the site only
            if request.distance_log16:
                d = np.clip(t.panorama_distance.astype(np.float64), 1.0, LOG16_MAX_M)
                arrays["panorama_distance_log16"] = np.rint(np.log(d) / np.log(LOG16_MAX_M) * 65535).astype(np.uint16)
        payload = terrain_payload.encode(_terrain_header(t, request), arrays)
        with terrain_lock:
            app.state.terrain_cache[key] = payload
            while len(app.state.terrain_cache) > TERRAIN_CACHE_SIZE:
                app.state.terrain_cache.popitem(last=False)
        return Response(payload, media_type="application/octet-stream")

    @app.post("/api/site/windows")
    def site_windows(request: SiteWindowsRequest) -> dict:
        """Direct sunlight and geometric Earth visibility at the panorama observer."""
        from lunar_sky import positions
        from lunar_sky.api import _spice_lock
        from lunar_sky.site_windows import visibility_windows

        if not getattr(app.state, "kernels_ready", False):
            raise HTTPException(503, "Lunar ephemeris kernels are unavailable.")
        try:
            with _spice_lock:
                if app.state.coverage is None:
                    app.state.coverage = positions.coverage_windows()
                coverage = app.state.coverage
            return visibility_windows(request.lat, request.lon, request.observer_elevation_m,
                                      request.start_utc, request.hours, request.skyline_deg,
                                      coverage, _spice_lock, include_next_event=request.include_next_event)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post(
        "/api/site/illumination",
        response_class=Response,
        responses={200: {"content": {"application/octet-stream": {}},
                         "description": "Binary illumination payload (lunar.api.terrain_payload)"}},
    )
    def site_illumination(request: IlluminationRequest) -> Response:
        """Horizon maps (cached per site) and the Sun's visible fraction over time."""
        from lunar_sky import positions
        from lunar_sky.api import _spice_lock

        from ..horizon_maps import NEAR_TARGET_M, map_surfaces
        from ..illumination import DARK, illumination_series, mission_solar_energy, mission_sunlight, summarise

        tiles = app.state.horizon_tiles
        if tiles is None:
            raise HTTPException(503, "No elevation maps available.")
        lon = float(wrap_longitude(request.lon))
        diameter = request.diameter_km * 1000
        t0 = time.perf_counter()
        try:
            hm = tiles.site(request.lat, lon, diameter, request.mast_height_m)
        except OSError as exc:
            raise HTTPException(503, f"Elevation map server unavailable: {exc}") from exc
        if not np.isfinite(hm.ground_m[hm.in_disc]).all():
            raise HTTPException(422, "Elevation maps do not cover the whole site.")
        near, _far = map_surfaces(app.state.terrain_products, NEAR_TARGET_M)
        hm.centre_ground_m = float(near(np.array([request.lat]), np.array([lon]))[0])
        t1 = time.perf_counter()
        eye_m = request.observer_elevation_m
        if eye_m is None:
            eye_m = hm.centre_ground_m + request.eye_height_m
        try:
            with _spice_lock:
                times, bodies, sun_m, sun_radius_m = positions.body_series(
                    request.lat, lon, eye_m, request.start_utc, request.hours, request.step_minutes,
                    include_end=request.include_mission_sunlight)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        t2 = time.perf_counter()
        lit, _az, _el = illumination_series(hm, sun_m, sun_radius_m)
        step_h = request.step_minutes / 60.0
        map_stats = {}
        if request.include_mission_sunlight:
            offsets = np.arange(len(times)) * step_h
            offsets[-1] = request.hours
            surface_hours, surface_dark = mission_sunlight(lit, hm.in_disc, offsets)
            energy = mission_solar_energy(hm, sun_m, lit, offsets)
            map_stats = {"mission_sunlit_h": surface_hours.astype(np.float32),
                         "mission_longest_dark_h": surface_dark.astype(np.float32),
                         "mission_solar_energy_kwh_m2": energy.astype(np.float32)}
            # Keep the playback frames on their existing, uniformly spaced time axis.
            count = int(np.floor(request.hours / step_h + 1e-9)) + 1
            times, lit = times[:count], lit[:count]
            bodies = {body: {key: values[:count] for key, values in columns.items()} for body, columns in bodies.items()}
        mean, longest = summarise(lit, hm.in_disc, step_h)
        t3 = time.perf_counter()
        header = {
            "site": {"lat": request.lat, "lon": lon, "diameter_km": request.diameter_km,
                     "mast_height_m": request.mast_height_m, "eye_m": round(eye_m, 2),
                     "eye_height_m": request.eye_height_m},
            "grid": {"nx": int(hm.in_disc.shape[1]), "ny": int(hm.in_disc.shape[0]), "spacing_m": hm.spacing_m,
                     "frame_anchor": [hm.anchor[0], hm.anchor[1]],
                     "first_m": [hm.i0 * hm.spacing_m, hm.j0 * hm.spacing_m],
                     "site_to_frame": hm.affine.tolist(), "site_to_frame_residual_m": round(hm.affine_residual_m, 3),
                     "layout": ("lattice nodes x = first_m[0] + i spacing, y = first_m[1] + j spacing (rows = y, "
                                "cols = x) in the azimuthal-equidistant plane of frame_anchor; a site point (x, y) "
                                "sits at frame A[:, :2] @ (x, y) + A[:, 2], A = site_to_frame"),
                     "tiles": hm.stats},
            "times": {"start_utc": times[0], "step_minutes": request.step_minutes, "count": len(times),
                      "end_utc": times[-1]},
            "method": ("Horizon maps (1 deg) per grid point; visible fraction of the Sun's disc (SPICE, LT+S) above "
                       "the horizon at each time step; lunar.horizon_maps and lunar.illumination. Sun and Earth "
                       "(sun_*/earth_*: azimuth, elevation, distance, angular radius) are apparent from the eye "
                       "(panorama eye elevation when supplied, otherwise site centre ground + eye_height_m), "
                       "as GET /api/v1/positions."),
            "timings_s": {"horizon_maps": round(t1 - t0, 3), "spice": round(t2 - t1, 3),
                          "illumination": round(t3 - t2, 3)},
        }
        if request.include_mission_sunlight:
            header["mission_sunlight"] = {"hours": request.hours, "visible_disc_threshold": DARK}
        arrays = {
            "node_site_xy_m": hm.site_xy_m.astype(np.float32),
            "in_disc": hm.in_disc.astype(np.uint8),
            "ground_m": hm.ground_m.astype(np.float32),
            "lit": np.rint(lit * 255).astype(np.uint8),
            "mean_lit": mean.astype(np.float32),
            "longest_dark_h": longest.astype(np.float32),
            **map_stats,
            **{f"{body}_{key}": values.astype(np.float32)
               for body, columns in bodies.items() for key, values in columns.items()},
        }
        return Response(terrain_payload.encode(header, arrays), media_type="application/octet-stream")

    field_cache: OrderedDict = OrderedDict()

    @app.post(
        "/api/site/shadow-field",
        response_class=Response,
        responses={200: {"content": {"application/octet-stream": {}},
                         "description": "Binary nested height grids (lunar.shadow_field)"}},
    )
    def site_shadow_field(request: ShadowFieldRequest) -> Response:
        """Nested height grids around the site, from the panorama's own surface."""
        from ..lola_chain import LolaChain
        from ..shadow_field import LEVELS, MAX_REACH_M, NO_DATA, SIZE, build_field
        from ..terrain import _surface

        lon = float(wrap_longitude(request.lon))
        key = (round(request.lat, 6), round(lon, 6), request.elevation_product)
        with terrain_lock:
            cached = field_cache.get(key)
            if cached is not None:
                field_cache.move_to_end(key)
                return Response(cached, media_type="application/octet-stream")
        products = app.state.lola_chain_products
        t0 = time.perf_counter()
        try:
            if request.elevation_product == "ldem_128":
                chain = None
                products = [min((p for p in products if p.name == "ldem_128"),
                                key=lambda p: bool(getattr(p, "is_remote", False)))]
            else:
                maps = best_maps(request.lat) if request.elevation_product == "best" else None
                chain = LolaChain(products, request.lat, lon, **({"maps": maps} if maps else {}))
            if chain is not None:
                source_cell = chain.normal_spacing
            else:
                source_cell = lambda d: products[0].pixel_size_m  # noqa: E731
            field = build_field(_surface(products, chain, request.lat, lon, 60.0), request.lat, lon,
                                source_cell=source_cell)
        except (LookupError, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc
        except OSError as exc:
            raise HTTPException(503, f"Elevation map server unavailable: {exc}") from exc
        header = {
            "site": {"lat": request.lat, "lon": lon},
            "levels": [{k: g[k] for k in ("half_m", "size", "spacing_m", "lo_m", "scale_m", "max_m", "despiked")}
                       for g in field],
            "no_data": NO_DATA, "max_reach_m": MAX_REACH_M,
            "layout": ("levels finest first; texel (i, j) centre at x = -half + (i + 1/2) 2 half / size (east), "
                       "y likewise (north), in the site's azimuthal-equidistant plane; height = lo + q scale (m above "
                       "the 1737.4 km sphere); q = no_data where no map covers the point"),
            "levels_spec_m": list(LEVELS), "size": SIZE,
            "timings_s": {"build": round(time.perf_counter() - t0, 3)},
        }
        payload = terrain_payload.encode(header, {"heights_q": np.stack([g["q"] for g in field])})
        with terrain_lock:
            field_cache[key] = payload
            while len(field_cache) > 4:
                field_cache.popitem(last=False)
        return Response(payload, media_type="application/octet-stream")

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


def _terrain_header(t, request: SiteTerrainRequest) -> dict:
    return {
        "elevation_product": request.elevation_product,
        "distance_log16_max_m": LOG16_MAX_M if request.distance_log16 else None,
        "elevation_maps": t.elevation_maps,
        "site": {"lat": t.lat, "lon": t.lon, "ground_m": round(t.ground_m, 2),
                 "eye_height_m": t.eye_height_m, "eye_m": round(t.eye_m, 2),
                 "diameter_km": request.diameter_km},
        "frame": ("East/North/Up metres from the eye, at the site. Vertex = (R + h) U(lat, lon) - eye, "
                  "R = 1737.4 km; Moon curvature included."),
        "site_grid": {
            "layout": "azimuthal equidistant: x east, y north, metres along the surface; rows = y, cols = x",
            "spacing_m": round(t.spacing_m, 3), "points": int(len(t.site_xy_m)),
            "map": t.site_map, "maps_used": maps_used(t.site_pixel_m), "despiked": t.site_despiked,
        },
        "surround": {"spacing_m": round(t.surround["spacing_m"], 3), "points": int(len(t.surround["xy_m"])),
                     "outer_radius_m": t.surround["outer_m"], "despiked": t.surround["despiked"]}
        if t.surround is not None else None,
        "skyline": {"azimuth_step_deg": request.far_azimuth_step_deg, "max_range_m": request.max_range_km * 1000}
        if t.ray_skyline_deg is not None else None,
        "panorama": {"rows": t.panorama_shade.shape[0], "columns": t.panorama_shade.shape[1],
                     "spike_correction": SPIKE_CORRECTION_STRENGTH,
                     "normal": ("panorama_normal: float16 (rows, columns, 2) = east, north components of the "
                                "unit surface normal in the site East/North/Up frame; up = sqrt(1 - e^2 - n^2)"),
                     "foreground_map": t.foreground_map, "foreground_pixel_m": t.foreground_pixel_m}
        if t.panorama_shade is not None else None,
        "far_mesh": {
            "layout": "rows = azimuth (clockwise from north), cols = ring distance along the surface",
            "azimuths": int(len(t.far_azimuth_deg)), "rings": int(len(t.far_distance_m)),
            "azimuth_step_deg": request.far_azimuth_step_deg, "relative_step": request.far_relative_step,
            "start_m": round(float(t.far_distance_m[0]), 1), "max_range_m": round(float(t.far_distance_m[-1]), 1),
            "map_target_m": FAR_TARGET_M, "maps_used": maps_used(t.far_pixel_m),
        } if request.include_far_mesh else None,
        "timings_s": {k: round(v, 3) for k, v in t.timings_s.items()},
        "radius_m": MOON_RADIUS_M,
    }

# Backend

One FastAPI service (`lunar_skyline.app:app`) serving two scientific modules:

- `lunar`: NASA LOLA terrain DEM, 360-degree horizons, first-person landscape (`/api/health`, `/api/horizon`, `/api/view`, `/api/ridges`).
- `lunar_sky`: JPL SPICE Sun/Earth apparent positions (`/api/v1/health`, `/api/v1/positions`, `/api/v1/positions/series`).

## Quick start (Windows PowerShell, Python 3.10+)

    cd backend
    powershell -ExecutionPolicy Bypass -File .\setup.ps1     # venv, deps, SPICE kernels, tests
    .\.venv\Scripts\python.exe scripts\fetch_dem.py --tier starter   # LOLA DEM (~128 MB)
    .\.venv\Scripts\python.exe -m uvicorn lunar_skyline.app:app --host 127.0.0.1 --port 8000

Then in `frontend/`: `npm install && npm run dev` (Vite proxies `/api` to port 8000). Either subsystem may be
unavailable (no kernels / no DEM) without disabling the other: `/api/v1/health` reports `degraded` and
`/api/health` reports `no elevation maps loaded`. Validation errors keep each family's format:
`{"error","detail"}` under `/api/v1/*`, FastAPI's default `detail` list elsewhere.
CORS: `LUNAR_CORS_ORIGINS` and `LUNAR_SKY_CORS_ORIGINS` (comma-separated) are merged; default is the Vite dev server.
The standalone apps (`lunar_sky.api:app`, `lunar.api.app:app`) still work. `pyproject.toml` (`pip install -e ".[dev]"`) and
`requirements.txt` (pinned, used by setup.ps1) both include numpy, fastapi, uvicorn, spiceypy, httpx, pytest.

Shared conventions: lunar radius 1737.4 km, planetocentric latitude, east-positive longitude, azimuth clockwise
from north, elevation above the local mathematical horizon. SPICE observer elevation = LOLA ground height + eye height.

# Part A: SPICE Sun/Earth (`lunar_sky`)

Fresh clone, Windows PowerShell, Python 3.10+ on PATH:

    cd backend
    powershell -ExecutionPolicy Bypass -File .\setup.ps1

This creates `.venv`, installs `requirements.txt`, downloads the kernels listed in
`kernels_manifest.json` from https://naif.jpl.nasa.gov/pub/naif/generic_kernels/ into
`kernels/` (git-ignored), verifies SHA-256, and runs `tests/test_kernels_smoke.py`.

Kernels: `de440s.bsp` (SPK), `moon_pa_de440_200625.bpc` (lunar PCK), `moon_de440_250416.tf`
(FK, defines `MOON_ME_DE440_ME421`), `naif0012.tls` (LSK). `pck00011.tpc` is not needed.
LOLA terrain data is Phase 2 and is not downloaded here.

### Phase 1B: apparent Sun/Earth from a lunar surface site

    python -m lunar_sky -89.5 223.0 0 2027-03-14T12:00:00Z      # lat, lon-east, elevation_m, UTC

or from Python (run from `backend/`):

    from lunar_sky.positions import calculate_positions
    r = calculate_positions(-89.5, 223.0, 0.0, "2027-03-14T12:00:00Z")
    r["sun"]["elevation_deg"], r["earth"]["azimuth_deg"]

Uses `spkcpo` (observer centre MOON, observer/output frame `MOON_ME_DE440_ME421`, output frame
evaluated at the observer epoch, `LT+S`). Latitude is planetocentric, longitude east-positive,
elevation is metres above a 1737.4 km sphere, azimuth is clockwise from lunar north, elevation is
relative to the local *mathematical* horizon: no terrain occlusion, no refraction, body centre not limb.
Timestamps must be explicitly UTC (`Z` or `+00:00`). At the exact poles azimuth is defined relative
to the supplied longitude's meridian (see `lunar_sky/positions.py`); elevation is unaffected.
Sun/Earth angular radii use 695700 km / 6371.0 km.

Tests: `python -m pytest -q`. Optional independent check against JPL Horizons (needs network):

    python scripts/horizons_compare.py -89.5 223.0 0 2027-03-14T12:00:00Z 2027-06-01T03:30:00Z

### Validation (configuration vs evidence)

*Configuration* (`scripts/horizons_compare.py` docstring + the `configuration` block of each JSON):
Horizons `CENTER=coord@301`, `COORD_TYPE=CYLINDRICAL` (planetocentric, R = 1737.4 km + h), `QUANTITIES=4,20`,
`APPARENT=AIRLESS`; ours is `spkcpo`, `LT+S`, `MOON_ME_DE440_ME421`. *Evidence* is the `evidence` list of live
Horizons responses in `horizons_residuals_*.json` (regenerate with `--json`; each file records `retrieved_utc`).
Runtime output keeps `validation_status: "pending"`: the calculator does not verify itself, and agreement at the
sites/epochs in those files does not certify other sites or dates. Observed residuals so far (<= 0.01 arcsec,
range < 0.004 km) cover the south pole, the equator and both exact poles at 2027-2028 epochs only.

### Leap seconds (`naif0012.tls`)
The LSK's last entry is 2017-JAN-1 (37 s). Later UTC is converted assuming no further leap seconds; a future
leap second would shift UTC->ET by 1 s (~0.5 arcsec of lunar rotation, ~0.5 arcsec of Earth/Sun azimuth).
Future UTC results are predictions, not validated against a leap-second schedule. `23:59:60` input is rejected.

### Earth radius
Earth angular radius uses the 6371.0 km mean sphere (Phase 1B approximation; equatorial 6378.137 km is 0.1 % larger).

### HTTP API (FastAPI)

Start (Windows PowerShell, from `backend/`):

    .\.venv\Scripts\python.exe -m uvicorn lunar_sky.api:app --host 127.0.0.1 --port 8000

Swagger UI: http://127.0.0.1:8000/docs

    GET /api/v1/health
    GET /api/v1/positions?lat=-89.5&lon=223&elevation_m=0&timestamp_utc=2027-03-14T12:00:00Z

`/positions` returns the `calculate_positions()` JSON unchanged (units/field names as in Phase 1).
`lon` is east-positive in [-360, 360], normalised to [0, 360); `elevation_m` defaults to 0.
Errors are `{"error", "detail"}`: 422 invalid/non-finite input or non-UTC timestamp; 400 date outside
kernel coverage / SPICE failure; 503 kernels missing or unloadable (`/health` then reports
`"status": "degraded"`); 500 unexpected (no stack trace returned).
Kernels load once at startup; SPICE calls are serialised with a lock (CSPICE is not thread-safe).

#### Time series: `GET /api/v1/positions/series`

    GET /api/v1/positions/series?lat=-89.5&lon=223&elevation_m=0&start_utc=2027-03-14T00:00:00Z&hours=168&step_minutes=60

Params: `lat`, `lon`, `elevation_m` as above; `start_utc` (explicit UTC); `hours` in (0, 168];
`step_minutes` in [10, 360]. Each sample uses the same `calculate_positions` math as `/positions`
(values are identical to individual calls).

Sampling: `t_k = start_utc + k*step_minutes`, k = 0..K, `K = floor(hours*60/step_minutes)`. The start is
always included. The end instant (`end_utc` = start + hours) is included only if it lands exactly on a
step (`end_included: true`); otherwise only samples before it are returned and `last_sample_utc` shows
the final one. `sample_count = K + 1` is capped at 1000 (422 beyond; e.g. 168 h at 10 min = 1009).
Response: `site`, `start_utc`, `end_utc`, `end_included`, `last_sample_utc`, `hours`, `step_minutes`,
`sample_count`, `samples[{timestamp_utc, sun, earth}]`, and `model` once (not per sample;
`terrain_occlusion_modelled: false`).
All sample times are checked against SPICE kernel coverage before any evaluation; a span reaching
outside it, or any failing sample, yields 400 (`ephemeris_unavailable`) with no partial result.
The SPICE lock is taken per 50-sample chunk, so long series interleave with other requests.

CORS: `http://localhost:5173` by default; override with `LUNAR_SKY_CORS_ORIGINS` (comma-separated).


# Part B: LOLA terrain (`lunar`)

Python backend for the Lunar Landing Site Navigator. It computes the real
local horizon at any lunar site from NASA LOLA elevation data, and later the
Sun and Earth positions on that horizon.

### Setup

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

### Elevation data

The maps come from NASA's PDS Geosciences Node (LRO LOLA gridded data). They
are too large for git, so they're downloaded into `backend/data/dem/`, which
git ignores.

```bash
.venv/bin/python scripts/fetch_dem.py --list            # see what's available
.venv/bin/python scripts/fetch_dem.py --tier starter    # ~128 MB, start here
```

| Tier | Contents | Size |
|---|---|---|
| starter | global 7.6 km and 1.9 km maps, south pole 240 m | ~128 MB |
| polar | north pole 240 m, south pole 80 m | ~289 MB |
| hires | global 237 m, south pole 20 m / 10 m / 5 m | ~15 GB |

The whole Moon is covered by the global map. The polar maps add finer detail
near the poles. For each point, the finest map that covers it is used.

### Running the API

```bash
.venv/bin/uvicorn lunar.api.app:app --reload        # http://127.0.0.1:8000, docs at /docs
```

```bash
curl -X POST http://127.0.0.1:8000/api/horizon -H 'Content-Type: application/json' \
  -d '{"lat": -89.45, "lon": 222.69, "observer_heights_m": [2, 10], "azimuth_step_deg": 0.5}'
```

`POST /api/horizon` returns `site` (normalised lon, ground height, map used),
`settings`, `meta` (frame and conventions) and one `skylines[]` entry per
observer height. Each entry holds same-length arrays in azimuth order:
`azimuth_deg`, `elevation_deg`, `distance_km`, `terrain_m`, `skyline_lat`,
`skyline_lon`, `map_pixel_size_m`, `at_max_range`. `GET /api/health` lists
the loaded maps.

`POST /api/view` (used by the frontend) takes one `observer_height_m`
(0-100 m, default 1.8) and returns the same `skyline` plus:
- `site_info`: ground and eye height vs the Moon's mean level, slope and the
  direction it faces, ground range within 1 km and 10 km, and a setting
  (low ground / high ground / mid-level / open flat)
- `landscape.segments`: for each azimuth, the visible terrain bottom to top as
  `[el_low_deg, el_high_deg, near_km, far_km, shade, edge, height_m]`
- `landscape.mean_level_elevation_deg`: per azimuth, where the Moon's mean
  level (height 0) would appear at the skyline's distance
- `smooth_horizon`: the flat-ground horizon for that eye height,
  `line_of_sight_m = sqrt(h(2R+h))`, `dip_deg = acos(R/(R+h))`, plus the same
  on Earth for comparison. CORS allows the Vite dev server (`LUNAR_CORS_ORIGINS` overrides).

`POST /api/ridges` (one `observer_height_m`, `azimuth_step_deg` default 0.25)
returns the reconstructed surroundings: `skyline` (farthest visible crest in
every direction), `ridgelines` (each a continuous crest line with per-point
azimuth, elevation, distance, height, lat/lon; sorted far to near for drawing)
and `peaks` (one summit per ridgeline, skyline first, >= 1 km away, spread out).

### Tests

```bash
.venv/bin/python -m pytest              # unit tests (synthetic data, no downloads)
.venv/bin/python -m pytest -s -m real_data   # cross-checks against downloaded maps
```

### Layout

```
lunar/
  config.py            constants (Moon radius, data folder)
  geometry.py          component 2: 3D positions, East/North/Up frame,
                       walking along the surface, azimuth/elevation to a point
  horizon.py           component 3: walk one compass direction, find the skyline
  skyline.py           component 4: the full 360 deg skyline, several observer heights
  landscape.py         component 7: the visible terrain below the skyline, as
                       per-direction strips of segments (for the first-person view)
  ridges.py            reconstruction 1: visible ridge crests per direction, on a
                       bicubic surface, refined between samples
  ridgelines.py        reconstruction 2: crests linked across directions into
                       ridgelines (far to near) + summit / peak list
  site.py              component 8: where you stand: height vs mean level, slope,
                       surroundings within 1 / 10 km, low/high-ground setting
  api/                 component 5: FastAPI app (app.py) and JSON shapes (schemas.py)
  dem/                 component 1: elevation data
    pds_label.py       read PDS3 .lbl files
    projections.py     lat/lon <-> pixel (cylindrical, polar stereographic)
    product.py         one elevation map: memory-mapped grid + height lookup
    catalog.py         known maps, download tiers, pick the best map for a point
scripts/fetch_dem.py   download maps from PDS
scripts/ray_section.py plot a terrain cross-section along one direction
                       (needs: pip install -e ".[plots]"; writes to output/)
scripts/skyline_plot.py plot the 360 deg skyline panorama of a site (same extra)
tests/
```

### Constants and assumptions

| | |
|---|---|
| Moon radius R | 1,737.4 km: the LOLA reference sphere (heights are relative to it); also what JPL Horizons uses. The IAU mean radius is 1,737.1 km; using it would move a 1.8 m horizon by 0.2 m. |
| Atmosphere | none: straight-line sight, no refraction |
| Search distance | 300 km (tested: no skyline beyond 154 km at 23 sites; 20 km relief can in theory be seen ~264 km away) |
| Sample spacing | max(half a map pixel, 0.5% of distance) |
| Height between pixels | bilinear interpolation of the 4 nearest pixel centres |
| Elevation angle | above the plane perpendicular to "up" (radial), not the local ground slope |
| Not modelled | features smaller than a map pixel, LOLA measurement error, lander tilt |

### Conventions

- Latitude in degrees, -90 to +90. Longitude in degrees **east-positive**;
  any range is accepted (-180..180 or 0..360).
- Heights are in **metres above the 1737.4 km reference sphere**, the same
  sphere JPL Horizons uses.
- Pixel coordinates are 0-based, and an integer value is the centre of a pixel.

# Backend (Phase 1: SPICE kernels)

Fresh clone, Windows PowerShell, Python 3.10+ on PATH:

    cd backend
    powershell -ExecutionPolicy Bypass -File .\setup.ps1

This creates `.venv`, installs `requirements.txt`, downloads the kernels listed in
`kernels_manifest.json` from https://naif.jpl.nasa.gov/pub/naif/generic_kernels/ into
`kernels/` (git-ignored), verifies SHA-256, and runs `tests/test_kernels_smoke.py`.

Kernels: `de440s.bsp` (SPK), `moon_pa_de440_200625.bpc` (lunar PCK), `moon_de440_250416.tf`
(FK, defines `MOON_ME_DE440_ME421`), `naif0012.tls` (LSK). `pck00011.tpc` is not needed.
LOLA terrain data is Phase 2 and is not downloaded here.

## Phase 1B: apparent Sun/Earth from a lunar surface site

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

## Validation (configuration vs evidence)

*Configuration* (`scripts/horizons_compare.py` docstring + the `configuration` block of each JSON):
Horizons `CENTER=coord@301`, `COORD_TYPE=CYLINDRICAL` (planetocentric, R = 1737.4 km + h), `QUANTITIES=4,20`,
`APPARENT=AIRLESS`; ours is `spkcpo`, `LT+S`, `MOON_ME_DE440_ME421`. *Evidence* is the `evidence` list of live
Horizons responses in `horizons_residuals_*.json` (regenerate with `--json`; each file records `retrieved_utc`).
Runtime output keeps `validation_status: "pending"`: the calculator does not verify itself, and agreement at the
sites/epochs in those files does not certify other sites or dates. Observed residuals so far (<= 0.01 arcsec,
range < 0.004 km) cover the south pole, the equator and both exact poles at 2027-2028 epochs only.

## Leap seconds (`naif0012.tls`)
The LSK's last entry is 2017-JAN-1 (37 s). Later UTC is converted assuming no further leap seconds; a future
leap second would shift UTC->ET by 1 s (~0.5 arcsec of lunar rotation, ~0.5 arcsec of Earth/Sun azimuth).
Future UTC results are predictions, not validated against a leap-second schedule. `23:59:60` input is rejected.

## Earth radius
Earth angular radius uses the 6371.0 km mean sphere (Phase 1B approximation; equatorial 6378.137 km is 0.1 % larger).

## HTTP API (FastAPI)

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

### Time series: `GET /api/v1/positions/series`

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

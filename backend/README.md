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

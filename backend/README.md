# Backend

Python backend for the Lunar Landing Site Navigator. It computes the real
local horizon at any lunar site from NASA LOLA elevation data, and later the
Sun and Earth positions on that horizon.

## Setup

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

## Elevation data

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

## Running the API

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

## Tests

```bash
.venv/bin/python -m pytest              # unit tests (synthetic data, no downloads)
.venv/bin/python -m pytest -s -m real_data   # cross-checks against downloaded maps
```

## Layout

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

## Constants and assumptions

| | |
|---|---|
| Moon radius R | 1,737.4 km: the LOLA reference sphere (heights are relative to it); also what JPL Horizons uses. The IAU mean radius is 1,737.1 km; using it would move a 1.8 m horizon by 0.2 m. |
| Atmosphere | none: straight-line sight, no refraction |
| Search distance | 300 km (tested: no skyline beyond 154 km at 23 sites; 20 km relief can in theory be seen ~264 km away) |
| Sample spacing | max(half a map pixel, 0.5% of distance) |
| Height between pixels | bilinear interpolation of the 4 nearest pixel centres |
| Elevation angle | above the plane perpendicular to "up" (radial), not the local ground slope |
| Not modelled | features smaller than a map pixel, LOLA measurement error, lander tilt |

## Conventions

- Latitude in degrees, -90 to +90. Longitude in degrees **east-positive**;
  any range is accepted (-180..180 or 0..360).
- Heights are in **metres above the 1737.4 km reference sphere**, the same
  sphere JPL Horizons uses.
- Pixel coordinates are 0-based, and an integer value is the centre of a pixel.

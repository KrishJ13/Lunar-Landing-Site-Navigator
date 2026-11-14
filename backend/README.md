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
  dem/                 component 1: elevation data
    pds_label.py       read PDS3 .lbl files
    projections.py     lat/lon <-> pixel (cylindrical, polar stereographic)
    product.py         one elevation map: memory-mapped grid + height lookup
    catalog.py         known maps, download tiers, pick the best map for a point
scripts/fetch_dem.py   download maps from PDS
tests/
```

## Conventions

- Latitude in degrees, -90 to +90. Longitude in degrees **east-positive**;
  any range is accepted (-180..180 or 0..360).
- Heights are in **metres above the 1737.4 km reference sphere**, the same
  sphere JPL Horizons uses.
- Pixel coordinates are 0-based, and an integer value is the centre of a pixel.

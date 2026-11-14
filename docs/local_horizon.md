# Local horizon: handover

Handover for whoever picks this up next (human or Claude). It covers what the
`feature/local_horizon` work does, how to run it, how it works, the decisions
the team has made, and what comes next.

Project: **NASA Space Apps 2026, "Lunar Landing Site Navigator"**. The challenge
asks for a tool that lets mission planners, educators and the public compare
landing sites and dates, showing the **Sun and Earth relative to the local
horizon** to judge power (sunlight) and direct-to-Earth communication.

**Status:** the local horizon is done. You can stand at any lat/lon on the
Moon, look around a true-proportion first-person view reconstructed from NASA
LOLA elevation data, and compare two sites or dates side by side.
**Not done yet:** placing the Sun and Earth in the view for the chosen date
(see "Next steps"; the approach is already verified).

Latest commit on the branch: `1810ea5 feature: 2d images of local horizon on any site, with calculated skyline`.

---

## 1. Run it

### Backend (Python 3.10+, FastAPI)

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -e ".[dev,plots]"
.venv/bin/python scripts/fetch_dem.py --tier starter   # ~128 MB of NASA LOLA maps into backend/data/dem/ (git-ignored)
.venv/bin/uvicorn lunar.api.app:app --reload           # http://127.0.0.1:8000, API docs at /docs
```

Run the tests:

```bash
.venv/bin/python -m pytest              # 132 tests, synthetic data, no downloads needed
.venv/bin/python -m pytest -s -m real_data   # cross-checks against the downloaded maps
```

On macOS with the python.org Python, HTTPS downloads need `certifi`, which is
already a dependency and used by `fetch_dem.py`.

### Frontend (React 19 + Vite)

```bash
cd frontend
npm ci
npm run dev        # http://localhost:5173, proxies /api to 127.0.0.1:8000 (vite.config.js)
npm run lint && npm run build   # what CI runs
```

`.claude/launch.json` has preview configurations named "backend" and
"frontend" for the Claude desktop app.

---

## 2. What the app does (frontend)

- **Site tiles.** Each tile has:
  - a form: preset site or custom lat/lon, a **date (UTC)** picker, eye height
    above ground (0–100 m slider, default 1.8 m), and direction spacing;
  - a **first-person view** you can look around in;
  - a **"Where you are standing" panel** below it: ground height vs the Moon's
    mean level, slope and the direction it faces, ground range within 1 km and
    10 km, a low / high / mid / flat setting, and a height gauge;
  - **"How far can I see?" facts:** flat-ground horizon distance vs Earth, the
    real skyline distances, and how much of the skyline is above eye level.
- **Compare:** "+ Compare with another site" opens a second tile side by side
  (max 2). Each tile has its own place, date and eye height and can be closed
  on its own. With two tiles, **"Align eye levels"** levels both views at
  once so their eye-level lines line up.
- **First-person view** (`FirstPersonView.jsx` + `LandscapeCanvas.jsx`):
  - always **true proportions**: 1° up equals 1° across, with no vertical stretch anywhere;
  - field of view 60/90/120/180° (default 120°);
  - **drag** to look around (with momentum), **arrow keys** (Shift for 1°), ◀ ▶ buttons and a heading slider (eased turning);
  - Up/Down or a vertical drag to tilt, and a "Level view" button;
  - a compass tape on top;
  - hovering shows direction, angle, terrain distance, and terrain height vs mean level and vs your eyes;
  - "reduce motion" switches off all animation.
- **Look of the view:**
  - black sky, terrain in **greys by distance: darker = nearer, lighter = farther** (log scale, 0.2–200 km);
  - **one line style** for everything: ridge crests, the skyline, and distance
    contours at 0.5, 1, 2, 5, 10, 20, 50, 100 and 200 km. All lines are thin
    and solid, shaded by distance with the same greys, traced into whole lines
    and smoothed;
  - a dashed yellow **eye-level line**;
  - **no** distance labels, no colour bar inside the view, no Moon-mean-level line, no flattened 360° panorama.
- **Date:** stored and shown per tile but **not used yet**, because terrain and
  the horizon don't depend on the date. It's there for the Sun and Earth step.

Frontend files:

| File | Role |
|---|---|
| `src/App.jsx` | Page: tiles, compare/align logic, shared distance legend |
| `src/components/SiteTile.jsx` | One site: form, view, panels; calls `/api/view` |
| `src/components/SiteForm.jsx` | Site, date, eye height and spacing inputs |
| `src/components/FirstPersonView.jsx` | Interaction (drag, keys, momentum, level); exposes `level()` via ref |
| `src/components/LandscapeCanvas.jsx` | Renderer (pixel-buffer fills + smoothed vector lines) and hover card |
| `src/components/CompassStrip.jsx` | Compass tape |
| `src/components/SitePanel.jsx`, `HeightGauge.jsx`, `HorizonFacts.jsx` | Info below the view |
| `src/lib/view.js` | Projection (azimuth/elevation ↔ screen), formatting helpers |
| `src/lib/lines.js` | Crests and contours from strips, `traceColumnChains` (line tracing and smoothing), `depth()` |
| `src/lib/colormap.js` | The grey distance scale and a 256-entry lookup table |
| `src/lib/motion.js` | Eased turns and drag momentum |
| `src/lib/sites.js` | Preset sites (south pole ones are approximate) |
| `src/api/horizon.js` | `fetchView` (used), `fetchHorizon`, `fetchRidges` (not used by the UI) |

---

## 3. How it works (backend)

Everything is in `backend/lunar/`, as small, tested modules built up in order.

1. **`dem/`: elevation data.**
   - **Maps:** NASA LRO LOLA gridded maps from the PDS Geosciences Node.
     - Starter set: `ldem_4` and `ldem_16` (global), `ldem_75s_240m` (south pole, 240 m/px).
     - More detail via `fetch_dem.py --tier polar|hires` (up to 5 m/px at the south pole, 237 m global).
     - The finest map covering a point is used automatically.
   - **Projections:** simple cylindrical and polar stereographic.
     - The PDS polar forward formula contradicts its own orientation text. We follow the inverse formula and the orientation text.
     - `tests/test_real_data.py` proves this: the polar and global maps agree to a median of 26 m, versus 1,948 m if the orientation were wrong.
   - **Interpolation:** bilinear by default (what the UI uses); bicubic (Catmull-Rom) also available.
2. **`geometry.py`: 3D maths in the Moon-fixed MOON_ME frame.**
   - Surface vectors, the East/North/Up frame, walking along great circles, and azimuth/elevation/range.
   - `geometric_horizon(h)` gives the exact flat-ground horizon:
     - line of sight `√(h(2R+h))`;
     - dip `acos(R/(R+h))`;
     - surface distance `R·dip`.
3. **`horizon.py`: one direction.** Walk outward from the eye, sample the terrain, and compute each point's elevation angle. The highest angle is the skyline.
4. **`skyline.py`: all directions** (default 0.5°), for several eye heights.
5. **`landscape.py`: what you actually see below the skyline.**
   - A sample is **visible** if it appears higher than everything closer.
   - Each direction becomes a strip of segments, bottom to top: `[el_low, el_high, near_km, far_km, shade, edge, height_m]`.
   - `edge = 1` marks terrain emerging behind a nearer ridge, i.e. a silhouette.
   - Neighbouring samples merge while distance grows ≤ ×1.5 and shade stays similar.
   - Also returns, per direction, where the Moon's mean level would appear (no longer drawn).
6. **`site.py`:** facts about where you stand: ground height, slope/aspect, surroundings within 1 and 10 km, and the setting.
7. **`api/app.py`:**
   - **`GET /api/health`**
   - **`POST /api/view`**: **used by the UI.** One eye height; returns skyline, landscape strips, site info and smooth-horizon numbers.
   - `POST /api/horizon`: skylines for several eye heights (not used by the UI).
   - `POST /api/ridges`: experimental, not used by the UI (see below).
   - CORS for the Vite dev server; responses are gzip-compressed.
8. **Experimental (kept, tested, not used by the UI):** `ridges.py` and `ridgelines.py`.
   - Bicubic surface; crests found per direction and refined with a parabola fit; linked across directions into ridgelines; a peak list.
   - Results: Shackleton's rim comes out as one continuous ridgeline, and Malapert at 134.15 km, −0.855°.
   - The team tried a renderer built on this and **reverted** to the current look. Keep it if you need peak lists or labels later.

### Constants and assumptions

| | |
|---|---|
| Moon radius | **1,737.4 km**: the LOLA reference sphere (heights are relative to it); also what JPL Horizons uses. The IAU mean radius is 1,737.1 km, which moves a 1.8 m horizon by only 0.2 m. |
| Atmosphere | None: straight-line sight, no refraction |
| Search distance | 300 km (tested on 23 sites: no skyline beyond 154 km; 20 km relief is visible up to ~264 km in theory) |
| Sampling along a ray | max(half a map pixel, 0.5% of distance) |
| Elevation angle | Above the plane perpendicular to radial "up", not the local ground slope |
| Azimuth | Clockwise from north. At an exact pole, "north" means the meridian of the longitude you entered. |
| Longitude | East-positive; any range accepted |
| Not modelled | Features smaller than a map pixel, LOLA measurement error, lander tilt |

**Checks you can rely on:**
- 1.8 m eye: horizon 2,500.93 m on the Moon (2,500.71 m with the IAU radius, which matches Wikipedia) and 4,789.11 m on Earth.
- Shackleton crater floor: the rim is +20–23.5° up, 9.5–11 km away, all round.
- Connecting ridge (−89.45°, 222.69°E): Mons Malapert is the skyline at azimuth ~144.7°, about 134 km away.

---

## 4. Decisions and preferences (please keep)

These come directly from the team's feedback during development:

- **True view only.** No vertical stretch, no flattened panorama.
- **Greyscale, darker = nearer.** No multi-colour maps, and no distance pills or labels in the view.
- **One line style for all lines**, smooth and continuous.
- **Eye-level line only.** The Moon-mean-level line was removed from the view; the "Moon mean level" mark in the height gauge panel is intentional.
- **Exact formulas, stated constants.** The team checks the maths against references, so when you add calculations, show the formula, use exact forms, and reconcile any difference.
- **Work component by component and pause for review** before moving on. Discuss design before big changes.
- **Near-field terrain is kept on purpose.** At 1.8 m on the 240 m map, the nearby ground often forms the skyline. That's a data-resolution limit, and the fix is finer maps.

---

## 5. Next steps

1. **Sun and Earth in the view for the tile's date.** The approach is already verified against JPL Horizons.
   - **Query** the Horizons API (`https://ssd.jpl.nasa.gov/api/horizons.api`, no key; send requests one at a time and cache results):
     ```
     EPHEM_TYPE=OBSERVER  COMMAND='301'  CENTER='500@399'  QUANTITIES='14,15,19,20'
     ```
     This gives the sub-Earth and sub-solar points on the Moon (MOON_ME, **east-positive**) and the Earth–Moon and Sun–Moon distances.
   - **Build vectors:** turn each into a Moon-fixed vector, subtract the site position, and project onto the site's East/North/Up frame with `lunar.geometry.look_angles`.
   - **Verified:** for site (−89.45°, 222.69°E) at 2026-12-01 00:00 UTC this gives **Sun az 57.3869°, el 1.7666°; Earth az 143.9707°, el −2.0549°**. That matches Horizons' own topocentric output (`CENTER='coord@301'`, `QUANTITIES='4'`, `APPARENT=AIRLESS`) to 0.0002°.
   - **Watch out:**
     - Subtracting the site position (parallax) moves **Earth by up to ~0.26°**, which matters at the pole.
     - The Sun's disk is about 0.53° across and Earth's about 1.9°.
     - `tests/test_geometry.py::test_matches_jpl_horizons_for_sun_and_earth` already encodes this check.
   - **Then:** draw them in `LandscapeCanvas` and judge them against the **terrain skyline**: sunlit or not, Earth visible or not, and time to sunset or Earthset.
2. **Better data near the pole.** Use `fetch_dem.py ldem_80s_20m` or `ldem_875s_5m` (~3.7 GB each), or add windowed HTTP range downloads, since the `.img` files are raw float32 grids.
3. **Possible additions:**
   - a "match direction" button for compare;
   - peak labels from `/api/ridges`, if the team wants them back;
   - frontend unit tests (none yet; CI runs lint and build only);
   - a backend CI job.

---

## 6. Repo map

```
backend/            Python package `lunar` (see backend/README.md for the module list and API details)
  data/dem/         downloaded LOLA maps (git-ignored)
  output/           debug plots from scripts/ (git-ignored)
  scripts/          fetch_dem.py, ray_section.py (cross-section plot), skyline_plot.py
  tests/            pytest, synthetic DEMs in conftest.py
frontend/           React + Vite app (see table above)
docs/local_horizon.md   this file
.github/workflows/frontend-ci.yml   lint + build on PRs to main
```

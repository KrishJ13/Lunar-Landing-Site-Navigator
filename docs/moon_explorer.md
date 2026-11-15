# Moon Explorer

Select sites in Moon Explorer at `/moon.html`. **Explore** opens a single site and
**Compare** opens two sites in Skyline V3 at `/skyline-v3.html`. The original
Skyline and V2 URLs forward to Moon Explorer.

## Run locally

Install Python 3.10 or later and Node.js 24, then open two terminals in the
repository root. Keep both running while you use the site.

### Terminal 1 · Backend on port 8000

On macOS or Linux:

```sh
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/python scripts/download_kernels.py
.venv/bin/python scripts/fetch_dem.py --tier starter
.venv/bin/python -m uvicorn lunar_skyline.app:app --host 127.0.0.1 --port 8000 --reload
```

On Windows PowerShell:

```powershell
cd backend
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe scripts/download_kernels.py
.\.venv\Scripts\python.exe scripts/fetch_dem.py --tier starter
.\.venv\Scripts\python.exe -m uvicorn lunar_skyline.app:app --host 127.0.0.1 --port 8000 --reload
```

After the first setup, run only the final command from `backend/`. The first
setup downloads SPICE kernels and the starter NASA elevation maps. Further
terrain data is downloaded as needed and cached in `backend/data/dem/cache/`.

### Terminal 2 · Frontend on port 5173

In the second terminal, from the repository root:

```sh
cd frontend
npm ci
npm run dev -- --port 5173 --strictPort
```

Open [Moon Explorer](http://localhost:5173/moon.html). A production server should serve the
Vite build output and forward `/api` to FastAPI on the same origin.

If the backend reports that port 8000 is already in use, check
[terrain health](http://127.0.0.1:8000/api/health) and
[SPICE health](http://127.0.0.1:8000/api/v1/health). Reuse a healthy backend from
the same checkout. If a different branch is running on port 8000, stop its
server in the terminal where you started it, then start this branch's backend.

## Explore and compare

1. Set the mission start and end in UTC. The globe shows lighting at the mission start.
2. Select a site by clicking the globe or opening **Enter coordinates**. Set its
   diameter in the selection card. Open **Settings** to set the playback interval,
   shadow height, and observer height shared by both sites.
3. Click **Explore**, or use **Add site to compare**, select another site, and click
   **Compare**. In Skyline V3, each site has its own date controls and timeline.
   Use **Moon Explorer** to return to the site selections.

## Viewing and lighting

The date fields accept UTC dates and times inside the installed DE440s kernel window
(1849-12-27 through 2150-01-21). The globe begins with celestial north up in the apparent
view from Earth's centre, including light travel time and lunar libration.

The renderer and pointer picking share a georeferenced sphere. The full sphere is drawn.
Selection is limited to the near hemisphere, the extra limb visible through natural
libration, and both polar caps from 75° latitude. Selection is independent of sunlight.
Latitude is planetocentric and longitude is east-positive in the Moon Mean Earth frame.
Displayed decimals are coordinate precision. Position accuracy also depends on the source
mosaic's registration and the spherical surface used for picking. Search accepts
signed decimal latitude and longitude in that order, separated by a comma or a space.
The clickable-area overlay uses the same geographic mask as pointer selection and search.
The selected site has an adjustable geodesic diameter from 5 to 50 km, with a
10 km default. The scale bar measures distance
at the centre of the globe view, where zoom is capped at 10 km per 96 CSS pixels.

The shader uses real terrain for local surface slopes and samples terrain along the
direction of sunlight near the terminator. It includes geometric Earth-shadow dimming
during lunar eclipses. The terrain sampling is approximate, and a low display fill makes
night-side terrain faintly visible. The renderer and hit test use a spherical limb.
The globe is intended for visual exploration rather than site-scale shadow prediction.

## Map sources and regeneration

Lunar colour is from the 8K 2019 [NASA Scientific Visualization Studio CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/),
which uses the LRO Wide Angle Camera mosaic with laser albedo at high latitudes.
Relief uses [NASA PDS LOLA gridded data](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/)
(LDEM 16 px/deg globally and LDEM 75N/75S at 240 m/pixel). For WebGL upload the relief rasters
are downsampled to 4096 pixels across globally and 2048 pixels across per pole.
The colour texture starts at 2K and is upgraded to 8K when zooming on supported GPUs.

The globe streams photographic detail from [NASA Moon Trek's public WMTS service](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=moon).
The shader samples each image in its published projection and uses its fine-scale
contrast with the bundled colour map, LOLA relief and SPICE sunlight. The bundled
maps also supply detail wherever a tile is missing or the service is unavailable.

| Image layer | Moon Trek identifier | Published detail |
| --- | --- | --- |
| Global WAC v2 | `LRO_WAC_Mosaic_Global_303ppd_v02` | ~100 m per source pixel, equirectangular WMTS through level 8 |
| North and south WAC | `LRO_WAC_Mosaic_NPole60_100mp`, `LRO_WAC_Mosaic_SPole60_100mp` | 100 m per source pixel, polar stereographic WMTS through level 4 (about 535 m per served pixel) |
| North and south NAC averages | `LRO_NAC_AvgMosaic_NPole855_1mp`, `LRO_NAC_AvgMosaic_SPole855_1mp` | 1 m per source pixel from about ±85.5° poleward, polar stereographic WMTS through level 11 (about 4.18 m per served pixel) |

The deepest zoom is available within the NAC polar regions. Dragging or using the pole
buttons anchors the view in lunar coordinates, so changing the observation time at
close range updates the lighting without moving the feature out of view. Moon Trek also has
site-specific Narrow Angle Camera layers, with varying coverage and registration.

The derived WebP textures and projection metadata are included in `frontend/public/moon`.
To regenerate them from the downloaded TIFF and PDS products, install Pillow in the
backend Python environment and run:

```sh
python backend/scripts/fetch_dem.py ldem_16 ldem_75n_240m ldem_75s_240m
python backend/scripts/prepare_moon_maps.py lroc_color_poles_8k.tif backend/data/dem frontend/public/moon
```

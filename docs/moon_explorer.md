# Moon Explorer

This copy of the project opens on a menu. The globe is at `/moon.html` and the existing
Lunar Skyline tool is at `/skyline.html`. Set `VITE_LUNAR_SKYLINE_URL` when building the
frontend to link the menu directly to an existing deployment.

From the repository root, after installing the existing backend dependencies and
[SPICE kernels](../backend/README.md):

```sh
cd backend
python -m uvicorn lunar_skyline.app:app --host 127.0.0.1 --port 8035
```

In another terminal, from the repository root:

```sh
cd frontend
npm ci
LUNAR_API_PROXY=http://127.0.0.1:8035 npm run dev -- --port 5187 --strictPort
```

Open [the local menu](http://127.0.0.1:5187/). A production server should serve the
Vite build output and forward `/api` to FastAPI on the same origin.

## Viewing and lighting

The date picker accepts whole UTC dates inside the installed DE440s kernel window
(1849-12-27 through 2150-01-21). The globe begins with celestial north up in the apparent
view from Earth's centre, including light travel time and lunar libration. The
illumination percentage refers to that Earth-facing geometry even when the camera is tilted.

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

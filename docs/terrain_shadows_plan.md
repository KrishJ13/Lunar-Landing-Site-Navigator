# Terrain, shadows and power: design plan

Status: proposal for review (revised 2026-11-15). Nothing here is built yet.

Goal: from a site (lat, lon), landing-site diameter D (5–50 km), eye/panel height
and a UTC date range, produce:
1. an interactive 360° wireframe of the real LOLA landscape seen from the site,
   with the Sun and Earth placed in it;
2. an accurate shadow (illumination) map over the site for any time;
3. power-generation metrics derived from it.

Data accuracy comes first and visual polish later. **Constraint: lightweight.**
Plain NumPy on a laptop-class backend, no GPU compute, no bulk downloads, and a
browser using WebGL2.

---

## 1. What limits us today

| Area | Today | Limitation |
|---|---|---|
| Landscape | `landscape.py` turns each azimuth into 1-D strips seen from **one eye point** | There is no 3-D surface, so we cannot ask whether *this* point on the ground is lit |
| Elevation data | Only the starter set is downloaded (`ldem_4`, `ldem_16`, `ldem_75s_240m`), and `heights_at` picks the finest map that covers a point | Away from the poles that means `ldem_16` at 1,895 m/px. Far finer LOLA products exist (§2) and are simply not catalogued or downloaded |
| Sun / Earth | SPICE: DE440s + `MOON_PA_DE440` binary PCK, `LT+S`, checked against JPL Horizons to 0.0002° | Correct already; it only needs evaluating at more points (§4) |

**NASA's three prompts, against this design:**

1. *Actual topography*: the whole design is built on the DEM (§2–§4).
2. *Libration and orbital variation*: already covered. The Moon-fixed frame
   `MOON_ME_DE440_ME421` is driven by the DE440 lunar orientation (physical libration),
   and the Sun and Earth come from the DE440 ephemeris (the Moon's orbit). The Earth's
   wander in the local sky (optical libration) falls out of the geometry.
3. *Steep slopes and deep craters at the poles*: per-point horizons (§4) on 5–20 m polar
   maps give permanently shadowed regions, long shadows and slope effects explicitly.

---

## 2. Elevation data: pick the LOLA product by the spacing we need

Every product below is on the PDS Geosciences Node LOLA volume, checked 2026-11-15.
All are raw float32 grids in metres or km above the 1,737.4 km sphere.

| Region | Products (pixel size) | Notes |
|---|---|---|
| ≥ 87.5° | `ldem_875{s,n}_{5,10,20}m` | Native LOLA track density is very high near the poles |
| ≥ 85° | `ldem_85{s,n}_{10,20,40}m` | |
| ≥ 80° | `ldem_80{s,n}_{20,40,80}m` | |
| ≥ 75° | `ldem_75{s,n}_{30,60,120,240}m` | |
| ≥ 60° | `ldem_60{s,n}_{60,120,240}m` | |
| global | **`ldem_512`** (16 tiles, 0.0592 km/px = 59.2 m) and `ldem_256` (118 m) | LOLA-only. The label states that GMT `surface` fills the "incomplete coverage" between ground tracks, so near the equator many pixels are interpolated |
| ±60° | **`sldem2015_512`** (32 tiles, 59.2 m) | LOLA co-registered with SELENE (Kaguya) Terrain Camera stereo, which fills the gaps between LOLA tracks without interpolation artefacts. **Used for sites below 60°** (§8) |

**The minimum 5 km site decides the resolution.** 5 km / 59.2 m ≈ **84 px** across at
low latitude, 250 px on the 20 m polar maps and 1,000 px on the 5 m maps. So:

- **Choose the product whose pixel is closest to the target spacing, not the finest one.**
  Target spacing is `s = max(native pixel, D / N)` with N ≈ 400 points across the site.
  - A 5 km south-polar site uses the 10–20 m maps.
  - A 50 km site at the pole uses the 120 m map, so it does not read 10,000² px of 5 m data.
  - Every site below 60° latitude uses `sldem2015_512`, with `ldem_128` beyond the site (§8).
- **Fetching.** The PDS server returns *multi-range* responses
  (`206 multipart/byteranges`, checked), and the grids are row-major. A site window is
  therefore **one HTTP request** listing one byte range per row, at ~0.5 s round trip.
  - A 5 km window at 59 m is 84 × 84 floats ≈ 28 KB.
  - Windows are cached as small `.npy` files under `data/dem/cache/`.
  - No multi-GB downloads.
- **The far field** (the horizon, out to the existing 300 km search) uses a coarser
  product, read the same way. Height error δh at distance d moves the horizon by
  δh / d. For example, 50 m at 100 km is 0.03°, against a solar disc 0.53° across.

**Interface.** A `RemoteDemProduct` with the same `heights_m()` as `DemProduct`, so
`horizon.py`, `skyline.py` and `site.py` work unchanged.

---

## 3. Terrain model: two simple meshes, both curved

1. **Site grid.** A regular azimuthal-equidistant grid over the site disc plus a margin,
   with spacing `s` from §2 (≤ ~400 × 400 points).
   - Each grid point (x east, y north metres along the surface) maps to (lat, lon) by the
     exact inverse formula, then gets a height from the DEM (bilinear, as now).
   - Positions use what `geometry.py` already does: `p = (R + h)·û(lat, lon) − o`,
     rotated into the site's East/North/Up frame.
2. **Far field.** An observer-centred **radial mesh**: azimuths at the existing 0.5°
   step × the existing log-spaced ray distances (`sample_distances`), out to 300 km.
   - These are exactly the samples `ray_profile` already computes for the skyline, so it
     is mostly reuse.
   - Its lines are range rings and radial spokes.

**The curvature is in both meshes and it is large.** Drop below the tangent plane is
d²/(2R): 134 km² / (2 × 1,737.4 km) = **5.17 km** at Mons Malapert seen from the
connecting ridge.

**Size.** ≤ 160k site points + 720 × ~250 far points ≈ 340k vertices, ~4 MB as float32
before gzip. Fine for WebGL2 on any laptop.

**Load the whole Moon in the browser? No.** At 59 m, SLDEM2015 is 32 × 1.4 GB, and the
polar maps are 3.7 GB each. Moon Explorer keeps its 4096 px relief textures for picking.
A click fetches one site package, cached on the backend by (site, D, height, product)
and in browser memory.

**The ray-cast skyline stays the reference.** A test checks that the meshes' highest
projected edge per azimuth matches `skyline.py` to within one cell's angular size.

---

## 4. Shadows: per-point horizon maps, NumPy only

For every point P of a **shadow grid** (a coarser copy of the site grid, ≤ ~150 × 150
points), and each azimuth α:

    H(P, α) = max over the terrain along azimuth α of the elevation angle seen from P

This is measured from P's own local horizontal plane, with P at ground + panel height.
It is what `horizon.py` already computes for the eye, vectorised over points.

Then for any time t:

1. **Sun direction at P.** Project the SPICE Sun vector (Moon-fixed) onto **P's own**
   East/North/Up basis.
   - Parallax across the site is negligible: 50 km / 1.496 × 10⁸ km = 3.3 × 10⁻⁷ rad.
   - But the local vertical turns by 50 km / 1,737.4 km = **1.65°** across a 50 km site,
     which is decisive at the poles, where the Sun is 0–2° up.
   - For Earth, parallax is 50 / 384,400 rad = 0.0075°, but the frame turn is the same 1.65°.
2. **Visible fraction** f(P, t) of the solar disc above H(P, ·), integrated over the
   disc. This is the same integral as `bodyVisibility()` in the frontend.
3. **Ground irradiance:** E = S(t) · f · max(0, n̂·ŝ), with n̂ the DEM surface normal.

**Keeping it light:**

- **Only the azimuths the Sun actually crosses in the requested window, plus its disc.**
  The Sun moves about 0.5° of azimuth per hour, so over 24 h it moves about 12°. That
  is about 30 azimuths at 0.5° instead of 720. Full-circle maps are only needed for
  month or year statistics, and they are cached once per site.
- **Split near from far.**
  - Rays from each point are sampled finely to R_split (a few × D).
  - The far horizon beyond R_split is computed on a small sub-grid (e.g. 9 × 9) and
    interpolated. The error is at most g / R_split rad for sub-grid spacing g, and a
    test enforces that.
  - Far terrain is mostly the same ridges for every point.
- **Rough cost:** 150² points × 30 azimuths × ~150 samples ≈ 10⁸ bilinear lookups, which
  takes seconds in NumPy. A full 720-azimuth map is about 24× that and is cached. These
  are estimates, to be measured in step 4.
- **Why not GPU shadow maps or per-step ray casting?** Horizon maps answer any time in
  the window with cheap lookups. The same maps also give **Earth visibility**
  (direct-to-Earth comms). GPU shadow maps are approximations: fine for visuals, not
  for numbers.

**Validation:**

1. At the eye point, the horizon map equals `skyline.py`.
2. Horizon-map illumination equals a direct ray cast toward the Sun, at random points and times.
3. Sun/Earth angles match JPL Horizons (existing test).
4. Polar results compared with published LOLA illumination studies (Mazarico et al.
   2011, *Icarus* 211) at well-known sites. Shadow edges compared with LROC images of
   known acquisition times (qualitative).

---

## 5. Wireframe view: a separate page, Lunar Skyline V2 (agreed 2026-11-15)

- **Where.** A developer page, `frontend/skyline-v2.html` (code in
  `frontend/src/skyline-v2/`), linked from the home menu. It handles one site at a time
  and is written as self-contained components, so it can later move into Moon Explorer.
  The original Lunar Skyline page is left unchanged.
- **Inputs.** Lat/lon (or a preset), eye height, landing-site diameter (5–50 km) and a
  **single** UTC date and time. The terrain mesh does not depend on the time; the time
  sets the Sun and Earth positions and the shadows.
- **Views.** First-person 360° (horizon, Sun/Earth) **and** an overhead view orbiting
  the site disc (shadows and, later, the heatmap).
- **Style.** Wireframe **grid squares** with no triangle diagonals, drawn by the shader
  where a grid coordinate is close to a whole number. Lines are anti-aliased via the
  shader's screen-space derivative, with adjustable thickness. Faces are opaque black,
  so hidden lines are removed. Lines are grey by distance, darker = nearer.
- **First-person projection.** Today's true-proportion cylindrical projection,
  az = atan2(E, N) and el = atan2(U, √(E² + N²)), so the terrain, skyline and Sun/Earth
  dots share one mapping.
- **Sun and Earth.** Unchanged: SPICE at ground + eye height. The terrain only decides
  whether they are blocked.

---

## 6. Power metrics (after shadows are validated)

Panel models and constants are to be agreed with the team:

- **Solar irradiance:** S(t) = 1361 W/m² · (1 AU / r☉(t))², using the total solar
  irradiance of 1360.8 ± 0.5 W/m² (Kopp & Lean 2011), with r☉ from SPICE.
- **Panel models:**
  - horizontal: cos i = sin e;
  - vertical, tracking the Sun around a vertical axis (the usual polar design): cos i = cos e;
  - fixed tilt.
- **Power per panel area:** P(t) = η · S(t) · f(t) · cos i(t).
- **Per-point outputs:** illuminated fraction, mean power, energy (Wh/m²), **longest
  continuous darkness** (battery sizing) and Earth-visible fraction.
- **Overlay.** A colour heatmap on the wireframe, the one deliberate exception to the
  greyscale rule.

---

## 7. Order of work (component by component, pause for review after each)

1. **DEM access — built (2026-11-15), awaiting review.** `lunar/dem/remote.py`
   (`RemoteGrid`, `open_remote`, `load_remote`) and `heights_at(..., target_m=)` in
   `catalog.py`.
   - **Offline tests:** `tests/test_remote.py`.
   - **Network tests,** run with `LUNAR_NETWORK_TESTS=1 pytest -s tests/test_remote_real.py`:
     - a remote `ldem_75s_240m` window is byte-identical to the downloaded file;
     - `ldem_512` vs `ldem_16`: median differences of 4, 43 and 2 m at three sites,
       against 278–7,704 m with the patch mirrored;
     - the step at the 90°E tile seam is at most 0.2 m;
     - `ldem_80s_20m` vs `ldem_75s_240m` at the connecting ridge: 3 m median.
   - **SLDEM2015 (added after the map decision changed):**
     - SLDEM2015 vs `ldem_512`: median 2.1, 4.0 and 1.7 m; vs `ldem_16`: 5, 44 and 3 m,
       against 279–7,693 m with the patch mirrored;
     - tile seams at 45°E and 30°N are continuous (median step < 5 m; maximum 6.1 and
       12.1 m, which includes the terrain's own curvature over 3 px);
     - no coverage beyond ±60°, so other maps take over there.
   - **Measured cold fetches:** 5 km polar site on the 10 m map, 401² points in 8.4 s;
     50 km polar site on the 120 m map in 4.5 s; 5 km Apollo 11 site on `ldem_512` in
     32 s, mostly a one-time fetch of the 16 tile labels. Labels are now fetched in
     parallel: a 5 km site on SLDEM2015 loads in about 1–3 s cold. Occasionally the
     PDS server drops a connection, which costs one 8 s timeout and a retry.
   - **Warm** (disk-cached): about 0 s.
   - **Not yet wired into `/api/view`.** That happens in step 2.

   Original scope: catalogue the products in §2, a multi-range `RemoteDemProduct` with a
   disk cache, and product choice by target spacing. Tests: a remote window is
   byte-identical to the same window of a local file (`ldem_75s_240m` is already
   downloaded), and `ldem_512` agrees with `ldem_16`, as `test_real_data.py` does for
   the polar maps.
2. **Site terrain package — built (2026-11-15), awaiting review.** Code is
   `lunar/terrain.py` and `POST /api/site/terrain`. The response is binary
   (`lunar/api/terrain_payload.py`): a JSON header, then float32 ENU vertices, heights
   and the in-disc mask.
   - **Maps.** Only this endpoint reads remote maps; `/api/view` and the others stay
     local-only. The site grid uses spacing max(D/400, map pixel) on the finest suitable
     map. The far mesh is 0.5° × rings 1 % apart from D/2 to 300 km, with map target
     240 m.
   - **Tests** (`tests/test_terrain.py`, synthetic maps):
     - every vertex equals the exact sphere formula u = R cos(d/R) − (R + eye) to 1 µm;
     - the 134 km drop is 2R sin²(d/2R) ≈ 5.17 km;
     - the site grid uses only the fine map and the far mesh never does;
     - mesh skyline vs `skyline.py`: ≤ 0.0008° on a 200 m map;
     - binary round trip, endpoint caching, and 422 below 5 km.
   - **Real sites** (mesh skyline vs `skyline.py` where the skyline is beyond the site):
     - connecting ridge on the same 240 m map: median 0.009°, maximum 0.035°. At Malapert
       (az 144.5°, 133.5 km) the mesh gives −0.866° and the reference −0.863°;
     - Chang'e 4 on the same `ldem_128` map: median 0.004°;
     - Apollo 11: median 0.053°. This is fully explained by the eye's ground height:
       SLDEM2015 puts it 5.5 m above `ldem_128`, and 5.5 m / 3.55 km = 0.089° matches the
       worst case of 0.087°. The two maps can differ by metres, so expect a small step
       where the site grid meets the far mesh.
   - **Size and speed.**
     - Payload: 5–8 MB uncompressed (e.g. connecting ridge, 5 km: a 403² site grid on the
       10 m map plus a 720 × 483 far mesh).
     - Build time: ~0.1 s with data cached. The first visit to a region takes ~20–30 s,
       mostly the 300 km `ldem_128` far field (~100 blocks, fetched 4 requests at a time),
       plus any server timeouts.
   - **Possible follow-up.** Send heights only and rebuild ENU in the browser, about
     3× smaller, at the cost of duplicating the geometry there.
3. **Lunar Skyline V2, built in stages; each stage waits for validation.**
   - *Superseded:* a first attempt (2026-11-15) put the wireframe into the original
     Skyline page behind a toggle. It was reverted, because the agreed direction is a
     separate page. Its geometry code is kept as a draft in
     `src/skyline-v2/terrainMesh.js`. A finding from it still stands: the mesh skyline
     matched the `/api/view` skyline to a 0.008° median at the connecting ridge.
   - **Stage 0 — built, awaiting validation.** The page, the menu card, the single-site
     form, the terrain request and a summary of what came back. The views are
     placeholders.
   - **Stage 1 — built (2026-11-15), awaiting validation.**
     - **Code.** `src/skyline-v2/gridWireframe.js` (WebGL2 renderer), `FirstPersonWireframe.jsx`,
       `OverheadWireframe.jsx` and `SkylineCheck.jsx`.
     - **Lines.** Drawn by the shader as squares in surface coordinates (x east, y north,
       metres along the ground), anti-aliased via the shader's screen-space derivative.
       Spacing is a round value near D/40, doubling with distance and halving near the
       eye down to the data spacing.
     - **Faces.** Dark grey and depth-tested, so hidden lines are removed. The amber circle
       is the site boundary.
     - **Near field.** Within 3 grid spacings of the eye, the first-person view uses a
       radial near mesh (1° steps from half a spacing out), interpolated on the site
       grid's own triangles.
     - **Reference skyline.** `POST /api/site/terrain` takes `include_ray_skyline`, which
       ray-casts the skyline (the `lunar.skyline` method) from the **same** maps as the
       mesh. A test shows it equals `compute_skyline` on a single map.
     - **Check at the connecting ridge** (10 km site, 1.8 m eye), all 720 azimuths:
       - skyline inside the site (593 azimuths): |Δh| median 0.17 m, max 0.78 m, where
         Δh = tan Δ × distance;
       - skyline beyond the site (127 azimuths): |Δ| median 0.0020°, max 0.031°;
       - a first version skipped the ground at the feet. That ground is the skyline in
         309 of 720 directions on this ridge, so the radial near mesh was added.
   - **Stage 2.** Sun and Earth dots on the skyline at the chosen instant. Check: against
     JPL Horizons.
   - **Stage 3.** The shadow map: per-point horizon maps (§4) and the lit fraction on the
     mesh. Checks: the eye point against `skyline.py`, and against direct ray casts.
   - **Stage 4.** The power heatmap (§6), after the metric is agreed.
4. **Move into Moon Explorer** once V2 is validated.

## 8. Decisions

- **Decided (2026-11-15, revised the same day): SLDEM2015 for sites below 60°.**
  `sldem2015_512` (LOLA + SELENE TC stereo, 59.2 m) replaces the first choice of
  LOLA-only `ldem_512`. The stereo fills the gaps between LOLA tracks instead of
  interpolating across them, so the linear track artefacts of pure-LOLA grids are gone.
  Barker et al. (2016) describe the product. `ldem_512` stays available in
  `remote_specs()` but is not loaded.
- **Decided (2026-11-15): fine map for the site, `ldem_128` beyond it.** The comparison
  below was made with `ldem_512`; SLDEM2015 agrees with `ldem_512` to a median of 2–4 m
  at the same sites (step 1 tests).
  - **Evidence.** Measured on 5 km sites at Apollo 11, Apollo 17 and Chang'e 4: the two
    maps' heights differ by a median of ≤ 1.0 m (RMS 1.4–3.3 m). That is negligible for
    horizon angles. But `ldem_512` keeps local slopes up to twice as steep (maximum
    14.5–22.2° vs 7.5–11.8°), which matters for self-shadowing and tilt inside the site.
    Some of that detail may be interpolation between LOLA tracks.
  - **Code.** `load_remote()` loads only `sldem2015_512` and `ldem_128` as non-polar maps
    (`DEFAULT_GLOBAL`).
  - **Step 2.** Pass target spacing = site spacing inside the site disc, and ≥ 237 m
    (`ldem_128`'s 2πR / (360·128) = 236.9 m) outside it, so SLDEM2015 is never read
    beyond the site.
  - **Polar sites** keep the polar maps, with the same rule: fine inside the disc,
    coarse beyond.
- Still open: default panel/mast height(s), panel model(s) and efficiency η for §6.

# Terrain, shadows and power: design plan

Historical design notes (revised 2026-11-15). References to the original and V2
frontends describe earlier implementations. See the [current app guide](moon_explorer.md)
for the Moon Explorer and Skyline V3 workflow.

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

## 5. The view: a separate page, Lunar Skyline V2 (agreed 2026-11-15, revised)

- **Where.** A developer page, `frontend/skyline-v2.html` (code in
  `frontend/src/skyline-v2/`), linked from the home menu. It handles one site at a time
  and is written as self-contained components, so it can later move into Moon Explorer.
  The original Lunar Skyline page is left unchanged.
- **Inputs.** Lat/lon (or a preset), eye height, landing-site diameter (5–50 km), a
  **single** UTC date and time, and the elevation data (LOLA resolution chain or
  `ldem_128` only). The terrain does not depend on the time; the time sets the Sun and
  Earth and the lighting.
- **The wireframe was dropped** (2026-11-15, commit `bd26fc7`). The first-person view is
  now a backend-rendered panorama: for every bearing (0.25° apart) and 1,024 elevation
  rows the backend finds the first ground the ray meets (`lunar/panorama.py`), and the
  browser draws it under the ray-cast skyline. The overhead view is the shaded site disc.
- **Elevation chain** (`lunar/lola_chain.py`): `ldem_512` near the site, blending to
  `ldem_256` over 2–4 km and to `ldem_128` over 12–20 km; `ldem_875{s,n}_5m` within
  320–640 m when |lat| ≥ 87.5°; a 5 m / ~59 m foreground patch within 320 m
  (`lunar/foreground.py`). *Open:* this is LOLA-only, while §8 chose SLDEM2015 for the
  site below 60°.
- **First-person projection.** True-proportion cylindrical: az = atan2(E, N),
  el = atan2(U, √(E² + N²)), shared by the terrain, skyline and Sun/Earth.

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
   - *Superseded:* Stage 1's grid wireframe was replaced by the shaded panorama (§5).
   - **Sun and Earth — built (2026-11-15).** Circles at true angular size on the
     first-person view, from `GET /api/v1/positions` with elevation_m = ground + eye
     (SPICE, `LT+S`, `MOON_ME_DE440_ME421`), hidden where V2's ray-cast skyline is above
     them (64-column disc integral). Code: `bodies.js`, `BodyTable.jsx`.
     - **vs JPL Horizons** (connecting ridge, eye 1,957.18 m, 2026-11-15 12:00 UTC,
       airless apparent): Sun az/el differ by 6×10⁻⁹° / 1×10⁻⁹°, Earth by 4×10⁻⁷° /
       4×10⁻⁸°, Earth range 403,953.14 vs 403,953.15 km.
     - **Sizes:** 2·asin(R/d). Sun (R = 695,700 km) equals Horizons to 0.000″. Earth uses
       the mean radius 6,371 km: 1.8074° vs Horizons' equatorial 1.8094° (0.11 %).
       Measured on screen at 5° FOV: Sun 0.5384° (true 0.5385°), Earth 1.9332° (true
       1.9336°). No minimum drawn size.
   - **Lighting from the real Sun, no shadows — built (2026-11-15).**
     - **Backend:** `panorama_normal`, float16 (rows, columns, 2) = east, north of the unit
       surface normal of the visible ground in each pixel, in the **site** ENU frame
       (curvature included: bare ground at d has normal tilted by d/R, 9.89° at 300 km).
       `_normals` crosses the across-bearing chord with the radial derivative over one
       cell; within 320 m the foreground patch's slopes are rotated into the site frame
       (Rodrigues, θ = d/R). About 5.9 MB extra.
     - **Shader** (`lighting.js`, shared by both views): Moon Explorer's model,
       scattering = mix(2μ₀/(μ₀+μ), μ₀, 0.19), direct = albedo·2.3·scattering·(Sun not
       behind Earth), uniform grey albedo 0.5 (sRGB). μ₀ is averaged over the Sun's disc
       (16 strips), so a facet the Sun is setting behind gets the part still above it.
       A fill from the viewer at 9 % of albedo is **not physical** (labelled on the page).
     - **Checks.** Tests: bare-sphere normals equal the local vertical to < 1×10⁻⁴°;
       a tilted plane to 1×10⁻⁹; foreground rotation exact. Real `ldem_128` (connecting
       ridge, Apollo 17, 400 points each): normals equal an independent geodesic + exact
       ENU calculation over the same span to 1.5×10⁻⁶°. Over a fixed one-cell span the
       median difference is 0.13° (Apollo 17) / 0.92° (ridge): across the line of sight
       the normal is averaged over the 0.25° bearing step (262 m at 60 km). GPU output
       vs an independent CPU evaluation: ≤ 0.66/255 over ~60,000 ground pixels, four views.
     - **Known gap until Stage 3:** ground facing the Sun is lit even if terrain stands
       between it and the Sun.
   - **Stage 3: horizon maps and sunlight over time — built (2026-11-15).** Chosen over
     per-instant ray-traced shadows (tried and dropped the same day): the goal is power over
     days and months, so, as the LOLA illumination studies (Mazarico et al. 2011) and solar
     GIS tools (GRASS `r.horizon`/`r.sun`, PVGIS) do, horizons are computed once and every
     time step is a lookup.
     - **Horizon maps** (`lunar/horizon_maps.py`): a 65 × 65 power grid over the site disc
       (156 m apart for 10 km), 1° directions, point 2 m above the ground (adjustable).
       Exact sphere geometry in each point's own frame; directions stored as site-grid
       azimuths with meridian convergence γ (±23° across a 10 km site at the connecting ridge).
       *Near* (≤ max(5 km, 8g) + g√2): a ~52 m height grid sampled by strided slices, one
       bilinear offset per (direction, distance) for all points. *Far* (to 300 km, 0.5 %
       steps): exact geodesic rays from a sub-grid (g = D/10, 12 × 12), interpolated with a
       height correction.
     - **Maps:** best by spacing (§2): polar 20–40 m maps at the poles, SLDEM2015 below 60°,
       240 m maps for far rays. Not the panorama's LOLA chain: its cylindrical `ldem_512`
       carries isolated spikes near the pole (+130 m in one sample at the connecting ridge),
       which cast false horizons up to 15°.
     - **Illumination** (`lunar/illumination.py`, `POST /api/site/illumination`): SPICE Sun
       per step (LT+S at the site), exact parallax per point, visible fraction of the disc
       by 16 vertical chords against the horizon (as `bodyVisibility`). Outputs lit
       fraction (T × n × n), % of time sunlit and longest darkness per point.
     - **Checks.** Map vs independent direct rays (25 points × 360 directions): connecting
       ridge median 0.019°, p99 0.87°; Apollo 17 median 0.023°, p99 0.39°. Tests: bare
       sphere horizon = dip −acos(R/(R+h)) to 0.001°; ridge vs direct rays; disc fraction =
       circular segment to 0.003; bare-sphere series.
     - **Speed:** maps 5.8 s (ridge) / 11.4 s (Apollo 17), cached; then one synodic month
       hourly in 0.9 s, a year at 6 h in 2.4 s.
     - **Sanity:** connecting ridge, 2 m, Dec 2026–Nov 2027 at 6 h: centre sunlit 82.6 %,
       best point 88.9 %, the range published for this ridge. Apollo 17: ~47 %.
     - **Page:** "Sunlight over time" panel; the overhead view shows shadows at any step
       (slider, play), % of time sunlit, or longest darkness; chart of the share of the
       site sunlit. The first-person panorama has no terrain shadows yet.
     - **To do:** a published-value comparison at named points; Earth visibility from the
       same maps; panorama shadows inside the site from the same maps.
   - **Load-time optimisation — built (2026-11-15).** Measured first: for a site a few km
     from the last, the page waited ~3 s (panorama) then ~6 s (horizon maps) in sequence.
     - **Horizon maps on a shared lattice** (`lunar/horizon_tiles.py`): points on a fixed
       grid per ~100 km frame (spacing 50·√2^k m nearest D/64), computed in 16 × 16 tiles,
       kept in memory and on disk (`data/dem/cache/horizons/`), and precomputed in the
       background within 3 tiles of each visited site (live requests take priority). A
       nearby site reuses its tiles; only tiles touching the disc are requested. Each
       node's value equals a directly computed block to 1e-4°; the site-to-lattice map is
       accurate to 4–6 cm.
     - **Faster per-node computation**, same results: compare tan(elevation) instead of
       atan2, float32 strided slices (near rays 2.6 → 0.8 s); far rays read one in-memory
       window of the map's own pixels (wrapping at longitude 0/360) instead of per-sample
       remote-grid lookups (Apollo 17: 12.2 → 4.2 s); exact per-corner height correction.
       Direct-ray validation unchanged: ridge median 0.018°, Apollo 17 0.023°.
     - **Frontend:** the terrain and sunlight requests run in parallel.
     - **Measured end to end** (10 km site, 3 days at 15 min): a site already covered
       ~1 s (was ~9 s); a new area with map data on disk ~5–6 s; moving 2–4 km before the
       background fill ~3–4 s. A region never visited still pays the first download of
       map blocks from PDS (tens of seconds, network-bound, then cached).
     - **Open:** near the poles the panorama's LOLA chain reads the cylindrical `ldem_512`/
       `ldem_256` grids, where a small circle crosses every longitude: one panorama touches
       thousands of 256-px blocks (slow) and these grids carry spikes there. The polar
       stereographic maps would be faster and cleaner; a data decision, not yet made.
   - **Lunar Skyline V3 — started (2026-11-15).** A separate page (`frontend/skyline-v3.html`,
     `src/skyline-v3/`, menu card) carrying over V2 and adding:
     - **Best maps** (`elevation_product: "best"`, `lunar.lola_chain.best_maps`): polar
       stereographic LOLA maps near the poles (|lat| ≥ 80: 20 → 120 → 240 m; 60–80: 60 → 120 →
       240 m; 5 m at the feet beyond 87.5°), SLDEM2015 → `ldem_256` → `ldem_128` below 60°.
       Polar panoramas ~25 % faster; skyline median within 0.02° of the LOLA chain.
     - **GPU terrain shadows for every visible point** (`lunar/shadow_field.py`,
       `POST /api/site/shadow-field`, `src/skyline-v3/shadowField.js`): four nested 1024²
       height grids from the panorama's own surface (±6 km at 11.7 m, ±30 km at 59 m,
       ±150 km at 293 m, ±600 km at 1.17 km; uint16, ~0.2 m steps); per ground point a
       straight 3-D ray to the Sun with the Moon's curvature, minimum clearance angle →
       visible part of the Sun's disc. Baked once per time step (24 ms for the whole
       panorama), so shadows cover the whole view and follow the timeline.
       Checks: Python reference vs horizon maps 100 % (Shackleton floor) / 99.1 %
       (connecting ridge) lit/unlit agreement; GPU vs Python on 400 panorama cells 100 %,
       max difference 0.008; tests for quantisation, bare sphere and a 500 m wall's
       5.7 km shadow. The Shackleton floor and its walls now stay dark with the Sun
       behind the rim.
     - **Exact pixel distances:** `panorama_distance_log16` (relative error 1e-4); the
       float16 array overflows beyond 65.5 km (harmless for V2, which uses it inside
       the site only).
     - **Overhead Sun/Earth markers:** true azimuth and elevation, schematic distance
       (0.8 D), labelled with the real distance.
     - **GPU-drawn foreground — built (2026-11-15).** A fifth, finest shadow-field level
       (±768 m at 1.5 m). Per pixel the shader marches the view ray from the eye over it
       (exact sphere geometry), shades the hit with the backend's own fixed-light formula
       (slopes over one source-map cell) plus sunlight and that point's shadow (baked per
       step on the same grid), and cross-fades to the panorama between 75 % and 95 % of the
       grid's reach. Seamless: mean brightness within 0.1–1 grey level of the panorama at
       three sites, four headings. **Finding:** it adds little visible detail, because the
       data has none to add: within a few metres of the feet one 5 m polar cell (59 m below
       60°) fills the view (1–6 grey levels at 0.7–3 m), and the 5 m map is smooth there
       (7.4 m relief within 50 m at the connecting ridge). Sharper ground needs finer data:
       LROC NAC DTMs (~2 m, at selected sites) or NAC photo texture (baked lighting).
   - **V3: spike correction, surround, time-varying maps — built (2026-11-15).**
     - **Spike correction** (`lunar/despike.py`): a node is an artefact when it stands above
       (below) every sample of a ring 1.5 source cells away and above (below) the radial
       profile continued inward (2 m1 − m2), both by more than max(8 m, 0.3 cell, 4 MAD);
       it is replaced by that continuation clipped to the ring's range. Ridges, rims and
       summits are kept (tests). Applied to the V3 site and surround grids, the shadow-field
       levels that resolve their source map, the horizon-map near grid and the far map's
       native-pixel window (horizon tile cache v2). On real data: cylindrical `ldem_512` at
       the connecting ridge 12 of 165,649 nodes (up to 614 m); polar 20 m map 24 of 1.4 M
       (≤ 42 m); 5 m map 2 (≤ 19 m). The panorama's rays keep their own peak correction.
     - **Overhead surround:** a 10 km ring beyond the site (`surround_km`, ~125 m grid),
       greyed, with the same GPU shadows (shadow grid 1024² over site + surround).
     - **Time-varying maps** replace "% of time sunlit" and "longest darkness": incident
       sunlight E = S·(Sun seen)·cos i on the local surface, S = 1361 W/m² × (1 AU / r)²
       (IAU 2015 B3), drawn per pixel from the same GPU shadows, square-root colour scale;
       and "dark for" (time each lattice point has been continuously dark up to the step).
     - **One shadow height:** the visible shadows use the form's point height, the same as
       the sunlight figures (horizon maps).
   - **Stage 4.** The power heatmap (§6), after the metric is agreed.
   - **Extensions noted:** Explorer's albedo map instead of uniform grey; physical
     earthshine instead of the fill; a "life-size" field of view.
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

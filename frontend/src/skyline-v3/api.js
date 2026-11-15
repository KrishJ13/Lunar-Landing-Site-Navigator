// API client for Lunar Skyline V3. Relative URLs: Vite proxies /api to the
// backend (vite.config.js); VITE_API_BASE overrides.
const API_BASE = import.meta.env.VITE_API_BASE ?? ''
export const SURROUND_KM = 10 // overhead context ring beyond the site edge (greyed)

async function errorMessage(response) {
  try {
    const { detail } = await response.json()
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) return detail.map((d) => `${d.loc?.at(-1)}: ${d.msg}`).join('; ')
  } catch {
    // fall through to the status text
  }
  return `Request failed (${response.status} ${response.statusText})`
}

/**
 * Fetch the landing-site mesh and its 360° horizon (POST /api/site/terrain;
 * backend/lunar/terrain.py). The response is binary: "LTER", uint32 version,
 * uint32 header length, JSON header, then 8-byte-aligned little-endian arrays
 * listed in header.buffers (see backend/lunar/api/terrain_payload.py).
 *
 * @returns {Promise<{header: object, arrays: Record<string, Float32Array|Uint8Array>}>}
 */
export async function fetchSiteTerrain({ lat, lon, diameterKm, observerHeightM, elevationProduct }, signal) {
  const response = await fetch(`${API_BASE}/api/site/terrain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat, lon, diameter_km: diameterKm, observer_height_m: observerHeightM,
      include_far_mesh: false, include_panorama: true, far_azimuth_step_deg: 0.25,
      elevation_product: elevationProduct, distance_log16: true, despike: true, surround_km: SURROUND_KM,
    }),
    signal,
  })
  if (!response.ok) {
    throw new Error(await errorMessage(response))
  }
  const { header, arrays } = decodeTerrainPayload(await response.arrayBuffer())
  if (header.elevation_product !== elevationProduct) {
    throw new Error('The terrain server did not select the requested LOLA mode. Restart the updated backend and try again.')
  }

  // Earlier terrain servers bundled the same ray-cast profile with the far mesh.
  const azimuths = arrays.ray_skyline_azimuth_deg ?? arrays.far_azimuth_deg
  const skyline = header.skyline ?? header.far_mesh
  if (!Number.isFinite(skyline?.azimuth_step_deg) || skyline.azimuth_step_deg <= 0 ||
      !azimuths?.length || arrays.ray_skyline_deg?.length !== azimuths.length ||
      arrays.ray_skyline_distance_m?.length !== azimuths.length) {
    throw new Error('The terrain server did not return a complete local horizon. Restart the backend and try again.')
  }
  const panorama = header.panorama
  if (!panorama || panorama.columns !== azimuths.length || !(panorama.rows > 1) ||
      arrays.panorama_shade?.length !== panorama.columns * panorama.rows) {
    throw new Error('The terrain server did not return the shaded panorama. Restart the updated backend and try again.')
  }

  if (arrays.panorama_distance_log16?.length !== panorama.columns * panorama.rows || !(header.distance_log16_max_m > 0)) {
    throw new Error('The terrain server did not return the pixel distances for shadows. Restart the updated backend and try again.')
  }
  if (arrays.panorama_normal?.length !== 2 * panorama.columns * panorama.rows) {
    throw new Error('The terrain server did not return the surface normals for lighting. Restart the updated backend and try again.')
  }

  return {
    header: { ...header, skyline },
    arrays: { ...arrays, ray_skyline_azimuth_deg: azimuths },
  }
}

// f2 (float16) stays as raw bits in a Uint16Array: WebGL2 uploads it as HALF_FLOAT.
const TYPED = { f4: Float32Array, f2: Uint16Array, u2: Uint16Array, u1: Uint8Array }

/** Split a terrain payload into its JSON header and typed-array views (no copies). */
export function decodeTerrainPayload(buffer) {
  const view = new DataView(buffer)
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4))
  if (magic !== 'LTER') throw new Error('Unexpected terrain data from the backend.')
  const version = view.getUint32(4, true)
  if (version !== 1) throw new Error(`Unsupported terrain data version ${version}.`)
  const length = view.getUint32(8, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, length)))
  const arrays = {}
  for (const b of header.buffers) {
    const Typed = TYPED[b.dtype]
    if (!Typed) throw new Error(`Unexpected array type ${b.dtype} in terrain data.`)
    arrays[b.name] = new Typed(buffer, b.offset, b.byte_length / Typed.BYTES_PER_ELEMENT)
  }
  return { header, arrays }
}

/**
 * Horizon maps on a power grid over the site disc and the visible fraction of
 * the Sun at every point and time step (POST /api/site/illumination;
 * backend/lunar/horizon_maps.py, backend/lunar/illumination.py). Binary payload
 * as fetchSiteTerrain. arrays.lit is (T, ny, nx) uint8 on the shared lattice
 * (backend/lunar/horizon_tiles.py), 255 = whole disc visible.
 */
export async function fetchIllumination({ lat, lon, diameterKm, mastHeightM, eyeHeightM, startUtc, hours, stepMinutes }, signal) {
  const response = await fetch(`${API_BASE}/api/site/illumination`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat, lon, diameter_km: diameterKm, mast_height_m: mastHeightM, eye_height_m: eyeHeightM,
      start_utc: startUtc, hours, step_minutes: stepMinutes,
    }),
    signal,
  })
  if (!response.ok) throw new Error(await errorMessage(response))
  const { header, arrays } = decodeTerrainPayload(await response.arrayBuffer())
  const nodes = (header.grid?.nx ?? 0) * (header.grid?.ny ?? 0)
  const count = header.times?.count
  if (!(nodes > 0) || !(count > 0) || arrays.lit?.length !== count * nodes || arrays.mean_lit?.length !== nodes ||
      header.grid.site_to_frame?.length !== 2) {
    throw new Error('The backend returned an incomplete illumination result. Restart the updated backend and try again.')
  }
  return { header, arrays }
}

/**
 * Nested height grids around the site for GPU shadows (POST /api/site/shadow-field;
 * backend/lunar/shadow_field.py): arrays.heights_q is (levels, size, size) uint16.
 */
export async function fetchShadowField({ lat, lon, elevationProduct }, signal) {
  const response = await fetch(`${API_BASE}/api/site/shadow-field`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lon, elevation_product: elevationProduct }),
    signal,
  })
  if (!response.ok) throw new Error(await errorMessage(response))
  const result = decodeTerrainPayload(await response.arrayBuffer())
  const { header, arrays } = result
  if (!header.levels?.length || arrays.heights_q?.length !== header.levels.length * header.size * header.size) {
    throw new Error('The backend returned incomplete shadow data. Restart the updated backend and try again.')
  }
  return result
}

// API client for Lunar Skyline V2. Relative URLs: Vite proxies /api to the
// backend (vite.config.js); VITE_API_BASE overrides.
const API_BASE = import.meta.env.VITE_API_BASE ?? ''

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
      elevation_product: elevationProduct,
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

  return {
    header: { ...header, skyline },
    arrays: { ...arrays, ray_skyline_azimuth_deg: azimuths },
  }
}

const TYPED = { f4: Float32Array, u1: Uint8Array }

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

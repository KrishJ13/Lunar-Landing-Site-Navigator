// Client for the backend horizon API (backend/lunar/api).
//
// In development, Vite proxies /api to the Python server (see vite.config.js).
// Set VITE_API_BASE to call a backend on another origin instead.

const API_BASE = import.meta.env.VITE_API_BASE ?? ''

/**
 * Fetch the 360° skyline(s) for a site.
 *
 * @param {object} params
 * @param {number} params.lat               degrees, -90..90
 * @param {number} params.lon               degrees east-positive, any range
 * @param {number[]} params.observerHeightsM eye heights above ground, metres
 * @param {number} [params.azimuthStepDeg]
 * @param {number} [params.maxRangeKm]
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} the HorizonResponse JSON (see backend/lunar/api/schemas.py)
 */
export async function fetchHorizon(
  { lat, lon, observerHeightsM, azimuthStepDeg, maxRangeKm },
  signal,
) {
  const body = {
    lat,
    lon,
    observer_heights_m: observerHeightsM,
    ...(azimuthStepDeg != null && { azimuth_step_deg: azimuthStepDeg }),
    ...(maxRangeKm != null && { max_range_km: maxRangeKm }),
  }
  const response = await fetch(`${API_BASE}/api/horizon`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    throw new Error(await errorMessage(response))
  }
  return response.json()
}

async function errorMessage(response) {
  try {
    const { detail } = await response.json()
    if (typeof detail === 'string') return detail
    // FastAPI validation errors: [{loc: [..., field], msg}, ...]
    if (Array.isArray(detail)) {
      return detail.map((d) => `${d.loc?.at(-1)}: ${d.msg}`).join('; ')
    }
  } catch {
    // fall through to the status text
  }
  return `Request failed (${response.status} ${response.statusText})`
}

/**
 * Fetch the first-person view data for one eye height: the skyline plus the
 * visible landscape strips (see backend/lunar/landscape.py).
 *
 * @param {object} params
 * @param {number} params.lat
 * @param {number} params.lon
 * @param {number} params.observerHeightM  eye height above ground, 0..100 m
 * @param {number} [params.azimuthStepDeg]
 * @param {AbortSignal} [signal]
 */
export async function fetchView({ lat, lon, observerHeightM, azimuthStepDeg }, signal) {
  const body = {
    lat,
    lon,
    observer_height_m: observerHeightM,
    ...(azimuthStepDeg != null && { azimuth_step_deg: azimuthStepDeg }),
  }
  const response = await fetch(`${API_BASE}/api/view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    throw new Error(await errorMessage(response))
  }
  return response.json()
}

/**
 * Fetch the reconstructed surroundings for one eye height: skyline, ridgelines
 * (far to near) and peaks (see backend/lunar/ridgelines.py), normalised so the
 * site panels can read `skyline` like the older /api/view shape.
 */
export async function fetchRidges({ lat, lon, observerHeightM, azimuthStepDeg }, signal) {
  const body = {
    lat,
    lon,
    observer_height_m: observerHeightM,
    ...(azimuthStepDeg != null && { azimuth_step_deg: azimuthStepDeg }),
  }
  const response = await fetch(`${API_BASE}/api/ridges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    throw new Error(await errorMessage(response))
  }
  const data = await response.json()
  return {
    ...data,
    skyline: {
      ...data.skyline,
      terrain_m: data.skyline.height_m,
      observer_height_m: data.observer_height_m,
    },
  }
}

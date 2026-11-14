// Relative URLs by default: Vite proxies /api to the unified backend. VITE_API_BASE overrides.
const BASE = import.meta.env.VITE_API_BASE ?? ''

export async function fetchPositions({ lat, lon, timestampUtc }, signal) {
  const qs = new URLSearchParams({ lat, lon, timestamp_utc: timestampUtc })
  let res
  try {
    res = await fetch(`${BASE}/api/v1/positions?${qs}`, { signal })
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new Error(`Cannot reach the backend. Is it running?`, { cause: e })
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.detail ?? `Request failed (${res.status})`)
  return body
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const validBody = (b) =>
  b && ['azimuth_deg', 'elevation_deg', 'distance_km', 'angular_radius_deg'].every((k) => isNum(b[k]))

export function validateSeries(body) {
  const ok =
    body &&
    body.site && isNum(body.site.latitude_deg) && isNum(body.site.longitude_deg_east) &&
    typeof body.start_utc === 'string' && typeof body.end_utc === 'string' &&
    isNum(body.step_minutes) && Array.isArray(body.samples) && body.samples.length > 0 &&
    body.samples.every((s) => typeof s?.timestamp_utc === 'string' && validBody(s.sun) && validBody(s.earth))
  if (!ok) throw new Error('The backend returned an unexpected time-series format.')
  if (body.sample_count !== undefined && body.sample_count !== body.samples.length)
    throw new Error('The backend time series is incomplete (sample count mismatch).')
  return body
}

export async function fetchSeries({ lat, lon, elevationM = 0, startUtc, hours, stepMinutes }, signal) {
  // elevationM = metres above the 1737.4 km sphere (LOLA ground height + eye height).
  const qs = new URLSearchParams({ lat, lon, elevation_m: elevationM, start_utc: startUtc, hours, step_minutes: stepMinutes })
  let res
  try {
    res = await fetch(`${BASE}/api/v1/positions/series?${qs}`, { signal })
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new Error(`Cannot reach the backend. Is it running?`, { cause: e })
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const d = body?.detail
    throw new Error(typeof d === 'string' ? d : d ? JSON.stringify(d) : `Request failed (${res.status})`)
  }
  return validateSeries(body)
}

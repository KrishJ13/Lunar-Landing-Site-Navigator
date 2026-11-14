const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'

export async function fetchPositions({ lat, lon, timestampUtc }, signal) {
  const qs = new URLSearchParams({ lat, lon, timestamp_utc: timestampUtc })
  let res
  try {
    res = await fetch(`${BASE}/api/v1/positions?${qs}`, { signal })
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new Error(`Cannot reach the backend at ${BASE}. Is it running?`, { cause: e })
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

export async function fetchSeries({ lat, lon, startUtc, hours, stepMinutes }, signal) {
  const qs = new URLSearchParams({ lat, lon, elevation_m: 0, start_utc: startUtc, hours, step_minutes: stepMinutes })
  let res
  try {
    res = await fetch(`${BASE}/api/v1/positions/series?${qs}`, { signal })
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new Error(`Cannot reach the backend at ${BASE}. Is it running?`, { cause: e })
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const d = body?.detail
    throw new Error(typeof d === 'string' ? d : d ? JSON.stringify(d) : `Request failed (${res.status})`)
  }
  return validateSeries(body)
}

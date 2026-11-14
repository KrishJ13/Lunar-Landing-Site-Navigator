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

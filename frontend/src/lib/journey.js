// The app journey: Moon Explorer (index.html) <-> Skyline View (skyline-v3.html, Skyline V4).
// Context travels in URL query parameters, so a reload, the browser's back button
// or a shared link restores the same site and time. Saved scenarios (A and B) live
// in localStorage so both pages see them. No React here.
//
// Coordinates are planetocentric degrees, longitude EAST-positive (as the backend).
// Times are UTC ISO 8601 with a trailing Z.

export const GLOBE_PAGE = './'
export const SITE_PAGE = './skyline-v3.html'
export const DEFAULT_HOURS = 72
export const DEFAULT_STEP_MINUTES = 15
export const SLOTS = ['A', 'B']

const finite = (value) => value !== null && value !== '' && Number.isFinite(Number(value))
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/

/** Longitude in (-180, 180]. */
export function wrapLongitude(lon) {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180
  return wrapped === -180 ? 180 : wrapped
}

/** "YYYY-MM-DDTHH:MMZ" for a Date or ISO string, or null when invalid. */
export function utcMinute(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16)}Z` : null
}

/** Normalise "…THH:MMZ" to "…THH:MM:00Z" (the form the backend and V3 use). */
const withSeconds = (utc) => (utc.length === 17 ? `${utc.slice(0, 16)}:00Z` : utc)

function siteParams(site) {
  const params = new URLSearchParams()
  params.set('lat', String(+site.lat.toFixed(5)))
  params.set('lon', String(+site.lon.toFixed(5)))
  if (site.diameterKm) params.set('d', String(site.diameterKm))
  if (site.name) params.set('name', site.name)
  return params
}

/** Site B of a two-site comparison, carried beside Site A as b-prefixed parameters. */
function addCompare(params, compare) {
  if (!compare) return
  params.set('blat', String(+compare.lat.toFixed(5)))
  params.set('blon', String(+compare.lon.toFixed(5)))
  if (compare.diameterKm) params.set('bd', String(compare.diameterKm))
}

/** Link into the Skyline View for a site and, optionally, a time window and observer settings. */
export function siteUrl(site, time = {}) {
  const params = siteParams(site)
  const start = time.startUtc && utcMinute(time.startUtc)
  if (start) params.set('start', start)
  if (time.hours) params.set('hours', String(+time.hours.toFixed(4)))
  if (time.stepMinutes) params.set('step', String(time.stepMinutes))
  if (time.eyeHeightM != null) params.set('eye', String(time.eyeHeightM))
  if (time.mastHeightM != null) params.set('mast', String(time.mastHeightM))
  // Comparison journey: save this site's results as Scenario `slot`, then offer Site B.
  if (SLOTS.includes(time.slot)) params.set('slot', time.slot)
  addCompare(params, time.compare)
  return `${SITE_PAGE}?${params}`
}

/** Link back to the Moon Explorer, centred on the site at a time. */
export function globeUrl(site, timeUtc, compare = null) {
  if (!site) return GLOBE_PAGE
  const params = siteParams(site)
  const t = timeUtc && utcMinute(timeUtc)
  if (t) params.set('t', t)
  addCompare(params, compare)
  return `${GLOBE_PAGE}?${params}`
}

/**
 * Site and time from a query string. Invalid or missing values come back null,
 * never guessed: { site: {lat, lon, diameterKm, name} | null, startUtc, hours,
 * stepMinutes, eyeHeightM, mastHeightM, timeUtc }.
 */
export function readJourney(search) {
  const params = new URLSearchParams(search)
  const readSite = (latKey, lonKey, dKey, nameKey) => {
    const lat = params.get(latKey)
    const lon = params.get(lonKey)
    if (!(finite(lat) && finite(lon) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 360)) return null
    const d = Number(params.get(dKey))
    return {
      lat: Number(lat),
      lon: Number(lon),
      diameterKm: Number.isInteger(d) && d >= 5 && d <= 50 ? d : null,
      name: (nameKey && params.get(nameKey)?.slice(0, 80)) || null,
    }
  }
  const site = readSite('lat', 'lon', 'd', 'name')
  const slot = params.get('slot')
  const time = (key) => {
    const value = params.get(key)
    return value && UTC_PATTERN.test(value) && Number.isFinite(Date.parse(value)) ? withSeconds(value) : null
  }
  const number = (key, min, max) => {
    const value = params.get(key)
    return finite(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null
  }
  return {
    site,
    startUtc: time('start'),
    timeUtc: time('t'),
    hours: number('hours', 0.25, 9600),
    stepMinutes: number('step', 15, 360),
    eyeHeightM: number('eye', 0, 100),
    mastHeightM: number('mast', 0, 50),
    slot: site && SLOTS.includes(slot) ? slot : null,
    compare: site ? readSite('blat', 'blon', 'bd', null) : null,
  }
}

// ---------- saved scenarios ----------

const STORE_KEY = 'lunar-skyline.scenarios.v1'

function storage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** { A: scenario | null, B: scenario | null }. Corrupt or missing storage reads as empty. */
export function loadScenarios() {
  const empty = { A: null, B: null }
  try {
    const parsed = JSON.parse(storage()?.getItem(STORE_KEY) ?? 'null')
    if (!parsed || typeof parsed !== 'object') return empty
    return { A: parsed.A ?? null, B: parsed.B ?? null }
  } catch {
    return empty
  }
}

function write(scenarios) {
  try {
    storage()?.setItem(STORE_KEY, JSON.stringify(scenarios))
    globalThis.dispatchEvent?.(new Event('lunar-scenarios'))
    return true
  } catch {
    return false
  }
}

/** Store a scenario in slot A or B; returns false when storage is unavailable. */
export function saveScenario(slot, scenario) {
  if (!SLOTS.includes(slot)) throw new Error(`Unknown scenario slot ${slot}`)
  return write({ ...loadScenarios(), [slot]: { ...scenario, slot, savedAt: new Date().toISOString() } })
}

export function clearScenario(slot) {
  return write({ ...loadScenarios(), [slot]: null })
}

/** The first empty slot, or B when both are full (A stays as the reference). */
export function nextSlot(scenarios) {
  return SLOTS.find((slot) => !scenarios[slot]) ?? 'B'
}

/** Short place label: "Apollo 11" or "−89.45000°, 222.69000°E". */
export function siteLabel(site) {
  if (!site) return ''
  return site.name || `${site.lat.toFixed(4)}°, ${site.lon.toFixed(4)}°E`
}

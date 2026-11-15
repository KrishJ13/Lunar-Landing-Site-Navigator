import { readJourney, wrapLongitude } from './journey.js'

export const PLAYBACK_INTERVALS = [15, 30, 60, 180, 360]
export const MIN_DIAMETER_KM = 5
export const MAX_DIAMETER_KM = 50
export const DEFAULT_SETTINGS = { stepMinutes: 15, mastHeightM: 2, eyeHeightM: 1.8 }

const DAY_MS = 86_400_000
const SETTINGS_KEY = 'lunar-mission-settings'
const MIN_UTC = '1849-12-27T00:00'
const MAX_UTC = '2150-01-21T00:00'

function boundedNumber(value, min, max, fallback) {
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

function normalizeSettings(values) {
  return {
    stepMinutes: PLAYBACK_INTERVALS.includes(values?.stepMinutes) ? values.stepMinutes : DEFAULT_SETTINGS.stepMinutes,
    mastHeightM: boundedNumber(values?.mastHeightM, 0, 50, DEFAULT_SETTINGS.mastHeightM),
    eyeHeightM: boundedNumber(values?.eyeHeightM, 0, 100, DEFAULT_SETTINGS.eyeHeightM),
  }
}

export function loadMissionSettings() {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY)))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveMissionSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)))
  } catch {
    // The active plan can still pass these settings in the URL.
  }
}

function utcDate(value) {
  return new Date(value).toISOString().slice(0, 16)
}

function validUtc(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value ?? '')) return false
  const ms = Date.parse(value + ':00Z')
  return Number.isFinite(ms) && utcDate(ms) === value
}

export function isMissionTime(value) {
  return validUtc(value) && value >= MIN_UTC && value <= MAX_UTC
}

export function defaultMissionDates() {
  const now = Math.floor(Date.now() / 60_000) * 60_000
  return { start: utcDate(now), end: utcDate(now + 3 * DAY_MS) }
}

export function missionRange(dates, stepMinutes) {
  const { start, end } = dates
  if (!validUtc(start) || !validUtc(end)) return { error: 'Enter a mission start and end in UTC.' }
  if (start < MIN_UTC || end > MAX_UTC) return { error: 'Choose dates between December 1849 and January 2150.' }
  const timeUtc = start + ':00Z'
  const hours = (Date.parse(end + ':00Z') - Date.parse(timeUtc)) / 3_600_000
  if (hours <= 0) return { error: 'Mission end must be after mission start.' }
  if (hours > 400 * 24) return { error: 'Choose a mission of 400 days or less.' }
  if (Math.floor(hours * 60 / stepMinutes + 1e-9) + 1 > 10_000) {
    return { error: 'Shorten the mission or increase the playback interval in Moon Explorer Settings.' }
  }
  return { timeUtc, hours }
}

function parseSite(value) {
  const fields = value.split(',')
  if (fields.length !== 3 || fields.some((field) => !field.trim())) return null
  const [lat, lon, diameterKm] = fields.map(Number)
  if (boundedNumber(lat, -90, 90, null) === null || boundedNumber(lon, -180, 180, null) === null ||
      boundedNumber(diameterKm, MIN_DIAMETER_KM, MAX_DIAMETER_KM, null) === null) return null
  return { lat, lon, diameterKm }
}

export function readMissionPlan(search) {
  const query = new URLSearchParams(search)
  const saved = loadMissionSettings()
  // Existing saved scenarios and share links use the older lat/lon query format.
  const legacy = query.has('site') ? null : readJourney(search)
  if (legacy?.site) {
    const defaults = defaultMissionDates()
    const start = (legacy.startUtc ?? legacy.timeUtc)?.slice(0, 16) ?? defaults.start
    const end = utcDate(Date.parse(start + ':00Z') + (legacy.hours ?? 72) * 3_600_000)
    const dates = { start, end }
    const sites = [legacy.site, legacy.compare].filter(Boolean).map(({ lat, lon, diameterKm }) =>
      ({ lat, lon: wrapLongitude(lon), diameterKm: diameterKm ?? 10 }))
    const settings = normalizeSettings(Object.fromEntries(Object.entries(saved).map(([key, val]) =>
      [key, legacy[key] ?? val])))
    return { sites, dates, settings, siteDates: sites.map(() => dates) }
  }
  const settings = normalizeSettings(Object.fromEntries(Object.entries(saved).map(([key, value]) =>
    [key, query.has(key) && query.get(key).trim() ? Number(query.get(key)) : value])))
  const defaultDates = defaultMissionDates()
  const start = query.get('start')
  const end = query.get('end')
  const dates = { start: validUtc(start) ? start : defaultDates.start, end: validUtc(end) ? end : defaultDates.end }
  const sites = query.getAll('site').slice(0, 2).map(parseSite).filter(Boolean)
  const siteDates = sites.map((_, index) => {
    const from = query.get(`start${index + 1}`)
    const to = query.get(`end${index + 1}`)
    return validUtc(from) && validUtc(to) ? { start: from, end: to } : dates
  })
  return { sites, dates, settings, siteDates }
}

export function missionUrl(page, { sites, dates, settings, siteDates = [] }) {
  const query = new URLSearchParams()
  for (const { lat, lon, diameterKm } of sites) query.append('site', [lat, lon, diameterKm].join(','))
  query.set('start', dates.start)
  query.set('end', dates.end)
  for (const [key, value] of Object.entries(settings)) query.set(key, String(value))
  for (const [index, range] of siteDates.entries()) {
    if (range.start === dates.start && range.end === dates.end) continue
    query.set(`start${index + 1}`, range.start)
    query.set(`end${index + 1}`, range.end)
  }
  return `./${page}?${query}`
}

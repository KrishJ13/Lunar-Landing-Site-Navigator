import { useEffect, useRef, useState } from 'react'
import { DEFAULT_HOURS, DEFAULT_STEP_MINUTES } from '../lib/journey.js'
import { PRESET_SITES } from '../lib/sites.js'

export const MIN_DIAMETER_KM = 5 // as Moon Explorer and the backend
export const MAX_DIAMETER_KM = 50
const MAX_EYE_HEIGHT_M = 100 // backend limit

const STEP_OPTIONS = [15, 30, 60, 180, 360] // minutes; 15 is the finest the backend allows
const MAX_STEPS = 10_000 // backend limit (e.g. about 3 months at 15 min)
const MIN_UTC = '1849-12-27T00:00'
const MAX_UTC = '2150-01-21T00:00'
// Window lengths in hours; 709 h is one synodic month (a full lunar day and night).
const DURATIONS = [[6, '6 hours'], [12, '12 hours'], [24, '1 day'], [72, '3 days'], [168, '1 week'],
  [336, '2 weeks'], [709, '1 lunar day (29.5 d)']]

/** Now (+ days), to the minute, as YYYY-MM-DDTHH:MM in UTC (a datetime-local value). */
function nowUtc() {
  return new Date().toISOString().slice(0, 16)
}

const parseUtc = (v) => Date.parse(v + ':00Z')
const fmtUtc = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

/**
 * Inputs for one landing site: where (preset or lat/lon), a UTC start and window
 * length, and in "Advanced" the time step, eye height, shadow point height and
 * landing-site diameter. `initial` (from the URL, lib/journey.js readJourney)
 * pre-fills it. Calls onSubmit({ lat, lon, siteName, eyeHeightM, diameterKm,
 * timeUtc, hours, stepMinutes, mastHeightM }).
 *
 * The terrain does not depend on the time; the window sets the Sun and Earth
 * positions and the shadows the timeline plays through.
 */
export default function SiteInputForm({ onSubmit, loading, initial = {}, built = false }) {
  const start = initial.site
  const startPreset = start
    ? PRESET_SITES.find((s) => s.name === start.name || (s.lat === start.lat && s.lon === start.lon))
    : PRESET_SITES[0]
  const [preset, setPreset] = useState(startPreset?.name ?? '')
  const [customName, setCustomName] = useState(startPreset ? null : start?.name ?? null)
  const [lat, setLat] = useState(String(start?.lat ?? startPreset.lat))
  const [lon, setLon] = useState(String(start?.lon ?? startPreset.lon))
  const [eyeHeight, setEyeHeight] = useState(initial.eyeHeightM ?? 1.8)
  const [diameter, setDiameter] = useState(start?.diameterKm ?? 10)
  const [when, setWhen] = useState(initial.startUtc?.slice(0, 16) ?? nowUtc())
  const [hours, setHours] = useState(initial.hours ?? DEFAULT_HOURS)
  const [stepMinutes, setStepMinutes] = useState(initial.stepMinutes ?? DEFAULT_STEP_MINUTES)
  const [mast, setMast] = useState(initial.mastHeightM ?? 2)
  const form = useRef(null)
  const autoSubmit = useRef(Boolean(start))

  // Arriving from the globe with a site in the URL: build it straight away.
  useEffect(() => {
    if (!autoSubmit.current) return
    autoSubmit.current = false
    form.current?.requestSubmit()
  }, [])

  function choosePreset(name) {
    setPreset(name)
    setCustomName(null)
    const site = PRESET_SITES.find((s) => s.name === name)
    if (site) {
      setLat(String(site.lat))
      setLon(String(site.lon))
    }
  }
  function editCoordinate(setter, value) {
    setter(value)
    setPreset('')
    setCustomName(null)
  }

  const latNum = Number(lat)
  const lonNum = Number(lon)
  const latOk = lat.trim() !== '' && Number.isFinite(latNum) && latNum >= -90 && latNum <= 90
  const lonOk = lon.trim() !== '' && Number.isFinite(lonNum) && lonNum >= -360 && lonNum <= 360
  const timeOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when) && !Number.isNaN(parseUtc(when))
  // Ephemeris coverage, as Moon Explorer (explorer/MoonExplorer.jsx MIN_DATE, MAX_DATE).
  const coveredOk = timeOk && when >= MIN_UTC && parseUtc(when) + hours * 3_600_000 <= parseUtc(MAX_UTC)
  const steps = Math.floor((hours * 60) / stepMinutes) + 1
  const rangeOk = coveredOk && hours > 0 && steps <= MAX_STEPS
  const ok = latOk && lonOk && timeOk && rangeOk
  const durations = DURATIONS.some(([h]) => h === hours) ? DURATIONS : [...DURATIONS, [hours, `${+(hours / 24).toFixed(2)} days`]]

  function submit(event) {
    event.preventDefault()
    if (!ok) return
    onSubmit({
      lat: latNum,
      lon: lonNum,
      siteName: preset || customName || null,
      eyeHeightM: eyeHeight,
      diameterKm: diameter,
      timeUtc: when + ':00Z',
      hours,
      stepMinutes,
      mastHeightM: mast,
    })
  }

  return (
    <form ref={form} className="sk-form" onSubmit={submit} aria-label="Site and time">
      <div className="sk-form-main">
        <label className="v2-field sk-field-site">
          <span>Landing site</span>
          <select value={preset} onChange={(e) => choosePreset(e.target.value)}>
            <option value="">{customName ? `${customName} (custom)` : 'Custom coordinates'}</option>
            {PRESET_SITES.map((s) => (
              <option key={s.name} value={s.name}>{s.name} ({s.note})</option>
            ))}
          </select>
        </label>
        <label className="v2-field sk-field-num">
          <span>Latitude °</span>
          <input inputMode="decimal" value={lat} aria-invalid={!latOk} aria-describedby="sk-lat-help"
            onChange={(e) => editCoordinate(setLat, e.target.value)} />
        </label>
        <label className="v2-field sk-field-num">
          <span>Longitude °E</span>
          <input inputMode="decimal" value={lon} aria-invalid={!lonOk}
            onChange={(e) => editCoordinate(setLon, e.target.value)} />
        </label>
        <label className="v2-field">
          <span>Start (UTC)</span>
          <input type="datetime-local" value={when} min={MIN_UTC} max={MAX_UTC} aria-invalid={!coveredOk} onChange={(e) => setWhen(e.target.value)} />
        </label>
        <label className="v2-field">
          <span>Window</span>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {durations.map(([h, label]) => <option key={h} value={h}>{label}</option>)}
          </select>
        </label>
        <button type="submit" className="sk-primary" disabled={!ok || loading}>
          {loading ? 'Loading…' : built ? 'Update' : 'Show site'}
        </button>
      </div>
      <p id="sk-lat-help" className={`v2-note sk-form-note ${ok ? 'v2-muted' : 'v2-error'}`} aria-live="polite">
        {!latOk ? 'Latitude must be between −90 and 90.'
          : !lonOk ? 'Longitude must be between −360 and 360 (east-positive).'
            : !timeOk ? 'Enter a valid UTC start.'
              : !coveredOk ? 'The window must lie between 27 December 1849 and 21 January 2150 (ephemeris coverage).'
              : steps > MAX_STEPS ? `${steps.toLocaleString()} steps: the most is ${MAX_STEPS.toLocaleString()}. Use a longer step or a shorter window.`
                : `${fmtUtc(parseUtc(when))} to ${fmtUtc(parseUtc(when) + hours * 3_600_000)} UTC · ${steps.toLocaleString()} steps of ${stepMinutes >= 60 ? `${stepMinutes / 60} h` : `${stepMinutes} min`}`}
      </p>
      <details className="sk-advanced">
        <summary>Advanced settings</summary>
        <div className="sk-advanced-grid">
          <label className="v2-field">
            <span>Time step</span>
            <select value={stepMinutes} onChange={(e) => setStepMinutes(Number(e.target.value))}>
              {STEP_OPTIONS.map((m) => <option key={m} value={m}>{m >= 60 ? `${m / 60} h` : `${m} min`}</option>)}
            </select>
          </label>
          <label className="v2-field">
            <span>Shadow point height (m): shadows and sunlight figures</span>
            <input type="number" min={0} max={50} step={0.5} value={mast} onChange={(e) => setMast(Number(e.target.value))} />
          </label>
          <label className="v2-field">
            <span>Eye height above ground: <strong>{eyeHeight} m</strong></span>
            <input type="range" min={0} max={MAX_EYE_HEIGHT_M} step={0.1} value={eyeHeight}
              onChange={(e) => setEyeHeight(Number(e.target.value))} />
          </label>
          <label className="v2-field">
            <span>Landing-site diameter: <strong>{diameter} km</strong></span>
            <input type="range" min={MIN_DIAMETER_KM} max={MAX_DIAMETER_KM} step={1} value={diameter}
              onChange={(e) => setDiameter(Number(e.target.value))} />
          </label>
        </div>
      </details>
    </form>
  )
}

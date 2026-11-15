import { useState } from 'react'
import { PRESET_SITES } from '../lib/sites.js'

export const MIN_DIAMETER_KM = 5 // as Moon Explorer and the backend
export const MAX_DIAMETER_KM = 50
const MAX_EYE_HEIGHT_M = 100 // backend limit

const STEP_OPTIONS = [15, 30, 60, 180, 360] // minutes; 15 is the finest the backend allows
const MAX_STEPS = 10_000 // backend limit (e.g. about 3 months at 15 min)

/** Now (+ days), to the minute, as YYYY-MM-DDTHH:MM in UTC (a datetime-local value). */
function nowUtc(days = 0) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 16)
}

const parseUtc = (v) => Date.parse(v + ':00Z')

/**
 * Inputs for one landing site: where (preset or lat/lon), eye height, landing-site
 * diameter, and a UTC time range with a step (15 min at the finest). Calls
 * onSubmit({ lat, lon, siteName, eyeHeightM, diameterKm, timeUtc, hours, stepMinutes,
 * mastHeightM, elevationProduct }).
 *
 * The terrain does not depend on the time; the range sets the Sun and Earth
 * positions and the shadows the timeline plays through.
 */
export default function SiteInputForm({ onSubmit, loading }) {
  const first = PRESET_SITES[0]
  const [preset, setPreset] = useState(first.name)
  const [lat, setLat] = useState(String(first.lat))
  const [lon, setLon] = useState(String(first.lon))
  const [eyeHeight, setEyeHeight] = useState(1.8)
  const [diameter, setDiameter] = useState(10)
  const [when, setWhen] = useState(nowUtc())
  const [until, setUntil] = useState(nowUtc(3))
  const [stepMinutes, setStepMinutes] = useState(15)
  const [mast, setMast] = useState(2)
  const [elevationProduct, setElevationProduct] = useState('lola_chain')

  function choosePreset(name) {
    setPreset(name)
    const site = PRESET_SITES.find((s) => s.name === name)
    if (site) {
      setLat(String(site.lat))
      setLon(String(site.lon))
    }
  }

  const latNum = Number(lat)
  const lonNum = Number(lon)
  const latOk = lat.trim() !== '' && Number.isFinite(latNum) && latNum >= -90 && latNum <= 90
  const lonOk = lon.trim() !== '' && Number.isFinite(lonNum) && lonNum >= -360 && lonNum <= 360
  const timeOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when) && !Number.isNaN(parseUtc(when))
  const hours = (parseUtc(until) - parseUtc(when)) / 3_600_000
  const steps = Math.floor((hours * 60) / stepMinutes) + 1
  const rangeOk = timeOk && Number.isFinite(hours) && hours > 0 && steps <= MAX_STEPS
  const ok = latOk && lonOk && timeOk && rangeOk

  function submit(event) {
    event.preventDefault()
    if (!ok) return
    onSubmit({
      lat: latNum,
      lon: lonNum,
      siteName: preset || null,
      eyeHeightM: eyeHeight,
      diameterKm: diameter,
      timeUtc: when + ':00Z',
      hours,
      stepMinutes,
      mastHeightM: mast,
      elevationProduct,
    })
  }

  return (
    <form className="v2-form" onSubmit={submit}>
      <label className="v2-field v2-wide">
        <span>Landing site</span>
        <select value={preset} onChange={(e) => choosePreset(e.target.value)}>
          <option value="">Custom coordinates</option>
          {PRESET_SITES.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} ({s.note})
            </option>
          ))}
        </select>
      </label>
      <label className="v2-field">
        <span>Latitude (°, −90 to 90)</span>
        <input inputMode="decimal" value={lat} aria-invalid={!latOk}
          onChange={(e) => { setLat(e.target.value); setPreset('') }} />
      </label>
      <label className="v2-field">
        <span>Longitude (°E)</span>
        <input inputMode="decimal" value={lon} aria-invalid={!lonOk}
          onChange={(e) => { setLon(e.target.value); setPreset('') }} />
      </label>
      <label className="v2-field">
        <span>Start (UTC)</span>
        <input type="datetime-local" value={when} aria-invalid={!timeOk} onChange={(e) => setWhen(e.target.value)} />
      </label>
      <label className="v2-field">
        <span>End (UTC)</span>
        <input type="datetime-local" value={until} aria-invalid={!rangeOk} onChange={(e) => setUntil(e.target.value)} />
      </label>
      <label className="v2-field">
        <span>Time step</span>
        <select value={stepMinutes} onChange={(e) => setStepMinutes(Number(e.target.value))}>
          {STEP_OPTIONS.map((m) => <option key={m} value={m}>{m >= 60 ? `${m / 60} h` : `${m} min`}</option>)}
        </select>
      </label>
      <p className={`v2-field v2-wide v2-note ${rangeOk ? 'v2-muted' : 'v2-error'}`}>
        {!(hours > 0) ? 'The end must be after the start.'
          : steps > MAX_STEPS ? `${steps.toLocaleString()} steps: the most is ${MAX_STEPS.toLocaleString()}. Use a longer step or a shorter range.`
            : `${(hours / 24).toFixed(2)} days in ${steps.toLocaleString()} steps.`}
      </p>
      <label className="v2-field">
        <span>Shadow point height (m)</span>
        <input type="number" min={0} max={50} step={0.5} value={mast} onChange={(e) => setMast(Number(e.target.value))} />
      </label>
      <label className="v2-field v2-wide">
        <span>Eye height above ground: <strong>{eyeHeight} m</strong></span>
        <input type="range" min={0} max={MAX_EYE_HEIGHT_M} step={0.1} value={eyeHeight}
          onChange={(e) => setEyeHeight(Number(e.target.value))} />
      </label>
      <label className="v2-field v2-wide">
        <span>Landing-site diameter: <strong>{diameter} km</strong></span>
        <input type="range" min={MIN_DIAMETER_KM} max={MAX_DIAMETER_KM} step={1} value={diameter}
          onChange={(e) => setDiameter(Number(e.target.value))} />
      </label>
      <label className="v2-field v2-wide">
        <span>Elevation data</span>
        <select value={elevationProduct} onChange={(e) => setElevationProduct(e.target.value)}>
          <option value="lola_chain">LOLA resolution chain</option>
          <option value="ldem_128">LOLA 128 only</option>
        </select>
      </label>
      <button type="submit" disabled={!ok || loading}>{loading ? 'Loading…' : 'Build landscape and timeline'}</button>
    </form>
  )
}

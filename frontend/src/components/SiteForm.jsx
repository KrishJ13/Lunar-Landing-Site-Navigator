import { useEffect, useRef, useState } from 'react'
import { PRESET_SITES } from '../lib/sites.js'

const AZIMUTH_STEPS = [0.1, 0.25, 0.5, 1]
const MAX_EYE_HEIGHT_M = 100 // matches the backend limit
const TIME_DEBOUNCE_MS = 500

const RANGES = [[24, '24 hours'], [72, '72 hours'], [168, '7 days']]
const DEFAULT_HOURS = 168 // the longest window the backend serves; makes the assessment meaningful

/** Start of today as YYYY-MM-DDTHH:MM in UTC (the value format of a datetime-local input). */
function todayUtc() {
  return new Date().toISOString().slice(0, 10) + 'T00:00'
}

const isValidDate = (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + ':00Z'))

/**
 * Choose where to stand and when, in three groups: Location (preset or coordinates),
 * Observation time (UTC start and playback range) and Observer (eye height, direction
 * spacing). Calls
 * onSubmit({ lat, lon, startUtc, hours, siteName, observerHeightM, azimuthStepDeg }).
 *
 * The date does not change the terrain; it selects the Sun/Earth time series. Once a result
 * is showing (`applied`), changing only the start or range refreshes the Sun/Earth series
 * by itself (debounced) through onTimeChange({ startUtc, hours }); location and eye height
 * still need "Stand here" because they need new terrain.
 */
export default function SiteForm({ onSubmit, onTimeChange, loading, applied, initialPresetIndex = 0, autoSubmit = false }) {
  const initial = PRESET_SITES[initialPresetIndex] ?? PRESET_SITES[0]
  const [lat, setLat] = useState(String(initial.lat))
  const [lon, setLon] = useState(String(initial.lon))
  const [preset, setPreset] = useState(initial.name)
  const [when, setWhen] = useState(todayUtc())
  const [hours, setHours] = useState(DEFAULT_HOURS)
  const [eyeHeight, setEyeHeight] = useState(1.8)
  const [azimuthStep, setAzimuthStep] = useState(0.5)
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  // Open on a real result: load the preset site for today straight away (once, on mount).
  const submitOnMount = useRef(autoSubmit)
  useEffect(() => {
    if (!submitOnMount.current) return
    submitOnMount.current = false
    onSubmit({
      lat: initial.lat,
      lon: initial.lon,
      startUtc: todayUtc() + ':00Z',
      hours: DEFAULT_HOURS,
      siteName: initial.name,
      observerHeightM: 1.8,
      azimuthStepDeg: 0.5,
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function choosePreset(name) {
    setPreset(name)
    const site = PRESET_SITES.find((s) => s.name === name)
    if (site) {
      setLat(String(site.lat))
      setLon(String(site.lon))
    }
  }

  function editCoordinate(setter) {
    return (event) => {
      setter(event.target.value)
      setPreset('')
    }
  }

  /** Apply a new start/range to the Sun/Earth series once typing settles. */
  function changeTime(nextWhen, nextHours) {
    setWhen(nextWhen)
    setHours(nextHours)
    clearTimeout(timer.current)
    if (!applied || !isValidDate(nextWhen)) return
    timer.current = setTimeout(() => onTimeChange({ startUtc: nextWhen + ':00Z', hours: nextHours }), TIME_DEBOUNCE_MS)
  }

  const latNum = Number(lat)
  const lonNum = Number(lon)
  const latOk = lat.trim() !== '' && Number.isFinite(latNum) && latNum >= -90 && latNum <= 90
  const lonOk = lon.trim() !== '' && Number.isFinite(lonNum) && lonNum >= -360 && lonNum <= 360
  const dateOk = isValidDate(when)
  const valid = latOk && lonOk && dateOk

  // Terrain inputs that differ from what is on screen.
  const terrainChanged =
    applied &&
    (applied.lat !== latNum ||
      applied.lon !== lonNum ||
      applied.observerHeightM !== eyeHeight ||
      applied.azimuthStepDeg !== azimuthStep)

  function submit(event) {
    event.preventDefault()
    if (!valid) return
    clearTimeout(timer.current)
    onSubmit({
      lat: latNum,
      lon: lonNum,
      startUtc: when + ':00Z',
      hours,
      siteName: preset || null,
      observerHeightM: eyeHeight,
      azimuthStepDeg: azimuthStep,
    })
  }

  return (
    <form className="site-form" onSubmit={submit} noValidate>
      <fieldset>
        <legend>Location</legend>
        <label className="field field-wide">
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
        <label className="field">
          <span>Latitude (°, −90 to 90)</span>
          <input
            inputMode="decimal"
            value={lat}
            onChange={editCoordinate(setLat)}
            aria-invalid={!latOk}
            aria-describedby={latOk ? undefined : 'lat-error'}
          />
          {!latOk && (
            <small id="lat-error" className="field-error">
              Enter a latitude from −90 to 90.
            </small>
          )}
        </label>
        <label className="field">
          <span>Longitude (°E)</span>
          <input
            inputMode="decimal"
            value={lon}
            onChange={editCoordinate(setLon)}
            aria-invalid={!lonOk}
            aria-describedby={lonOk ? undefined : 'lon-error'}
          />
          {!lonOk && (
            <small id="lon-error" className="field-error">
              Enter a longitude from −360 to 360.
            </small>
          )}
        </label>
      </fieldset>

      <fieldset>
        <legend>Observation time (UTC)</legend>
        <label className="field">
          <span>Start date and time</span>
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => changeTime(e.target.value, hours)}
            aria-invalid={!dateOk}
            aria-describedby={dateOk ? undefined : 'time-error'}
          />
          {!dateOk && (
            <small id="time-error" className="field-error">
              Enter a valid UTC date and time.
            </small>
          )}
        </label>
        <label className="field">
          <span>Sun/Earth range</span>
          <select value={hours} onChange={(e) => changeTime(when, Number(e.target.value))}>
            {RANGES.map(([h, t]) => (
              <option key={h} value={h}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <small className="field-hint field-wide">
          {applied ? 'Time changes update the Sun and Earth automatically.' : 'Sampled hourly from the start time.'}
        </small>
      </fieldset>

      <fieldset>
        <legend>Observer</legend>
        <label className="field field-wide">
          <span>
            Eye height above ground: <strong>{eyeHeight} m</strong>{' '}
            <span className="muted">(1.8 m ≈ standing astronaut; higher = lander mast or tower)</span>
          </span>
          <input
            type="range"
            min={0}
            max={MAX_EYE_HEIGHT_M}
            step={0.1}
            value={eyeHeight}
            onChange={(e) => setEyeHeight(Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Direction spacing</span>
          <select value={azimuthStep} onChange={(e) => setAzimuthStep(Number(e.target.value))}>
            {AZIMUTH_STEPS.map((s) => (
              <option key={s} value={s}>
                every {s}°
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <div className="form-actions">
        <button type="submit" className="primary" disabled={!valid || loading}>
          {loading ? 'Computing…' : 'Stand here'}
        </button>
        {terrainChanged && !loading && (
          <span className="field-hint" role="status">
            Location or eye height changed. Press Stand here to update the view.
          </span>
        )}
      </div>
    </form>
  )
}

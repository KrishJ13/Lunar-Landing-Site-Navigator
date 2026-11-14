import { useState } from 'react'
import { PRESET_SITES } from '../lib/sites.js'

const AZIMUTH_STEPS = [0.1, 0.25, 0.5, 1]
const MAX_EYE_HEIGHT_M = 100 // matches the backend limit

const RANGES = [[24, '24 hours'], [72, '72 hours'], [168, '7 days']]

/** Start of today as YYYY-MM-DDTHH:MM in UTC (the value format of a datetime-local input). */
function todayUtc() {
  return new Date().toISOString().slice(0, 10) + 'T00:00'
}

/**
 * Choose where to stand and when: a preset site or custom coordinates, a
 * start date and time (UTC) with a playback range, and how high your eyes are
 * above the ground. Calls
 * onSubmit({ lat, lon, startUtc, hours, siteName, observerHeightM, azimuthStepDeg }).
 *
 * The date does not change the terrain; it selects the Sun/Earth time series.
 */
export default function SiteForm({ onSubmit, loading, initialPresetIndex = 0 }) {
  const initial = PRESET_SITES[initialPresetIndex] ?? PRESET_SITES[0]
  const [lat, setLat] = useState(String(initial.lat))
  const [lon, setLon] = useState(String(initial.lon))
  const [preset, setPreset] = useState(initial.name)
  const [when, setWhen] = useState(todayUtc())
  const [hours, setHours] = useState(24)
  const [eyeHeight, setEyeHeight] = useState(1.8)
  const [azimuthStep, setAzimuthStep] = useState(0.5)

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

  const latNum = Number(lat)
  const lonNum = Number(lon)
  const latOk = lat.trim() !== '' && Number.isFinite(latNum) && latNum >= -90 && latNum <= 90
  const lonOk = lon.trim() !== '' && Number.isFinite(lonNum) && lonNum >= -360 && lonNum <= 360
  const dateOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when) && !Number.isNaN(Date.parse(when + ':00Z'))

  function submit(event) {
    event.preventDefault()
    if (latOk && lonOk && dateOk) {
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
  }

  return (
    <form className="site-form" onSubmit={submit}>
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
        <input inputMode="decimal" value={lat} onChange={editCoordinate(setLat)} aria-invalid={!latOk} />
      </label>

      <label className="field">
        <span>Longitude (°E)</span>
        <input inputMode="decimal" value={lon} onChange={editCoordinate(setLon)} aria-invalid={!lonOk} />
      </label>

      <label className="field">
        <span>Start date and time (UTC)</span>
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-invalid={!dateOk} />
      </label>

      <label className="field">
        <span>Sun/Earth range</span>
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          {RANGES.map(([h, t]) => (
            <option key={h} value={h}>
              {t}
            </option>
          ))}
        </select>
      </label>

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

      <button type="submit" disabled={!(latOk && lonOk && dateOk) || loading}>
        {loading ? 'Computing…' : 'Stand here'}
      </button>
    </form>
  )
}

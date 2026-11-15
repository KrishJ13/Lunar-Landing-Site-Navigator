import { useState } from 'react'
import { PRESET_SITES } from '../lib/sites.js'

export const MIN_DIAMETER_KM = 5 // as Moon Explorer and the backend
export const MAX_DIAMETER_KM = 50
const MAX_EYE_HEIGHT_M = 100 // backend limit

/** Now, to the minute, as YYYY-MM-DDTHH:MM in UTC (a datetime-local value). */
function nowUtc() {
  return new Date().toISOString().slice(0, 16)
}

/**
 * Inputs for one landing site: where (preset or lat/lon), eye height, landing-site
 * diameter and one UTC instant. Calls
 * onSubmit({ lat, lon, siteName, eyeHeightM, diameterKm, timeUtc, elevationProduct }).
 *
 * The terrain does not depend on the time; the time sets the Sun and Earth
 * positions (Stage 2) and the shadows (Stage 3).
 */
export default function SiteInputForm({ onSubmit, loading }) {
  const first = PRESET_SITES[0]
  const [preset, setPreset] = useState(first.name)
  const [lat, setLat] = useState(String(first.lat))
  const [lon, setLon] = useState(String(first.lon))
  const [eyeHeight, setEyeHeight] = useState(1.8)
  const [diameter, setDiameter] = useState(10)
  const [when, setWhen] = useState(nowUtc())
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
  const timeOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when) && !Number.isNaN(Date.parse(when + ':00Z'))
  const ok = latOk && lonOk && timeOk

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
        <span>Date and time (UTC)</span>
        <input type="datetime-local" value={when} aria-invalid={!timeOk} onChange={(e) => setWhen(e.target.value)} />
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
      <button type="submit" disabled={!ok || loading}>{loading ? 'Loading terrain…' : 'Build landscape'}</button>
    </form>
  )
}

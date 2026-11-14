import { useEffect, useRef, useState } from 'react'
import { fetchPositions } from './api'
import SkyChart from './SkyChart'
import './App.css'

const DEFAULTS = { lat: '-89.5', lon: '223', when: '2027-03-14T12:00' }

function validate({ lat, lon, when }) {
  const errs = {}
  const la = Number(lat)
  const lo = Number(lon)
  if (lat.trim() === '' || !Number.isFinite(la) || la < -90 || la > 90) errs.lat = 'Latitude must be between -90 and 90.'
  if (lon.trim() === '' || !Number.isFinite(lo) || lo < -360 || lo > 360) errs.lon = 'Longitude must be between -360 and 360.'
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(when) || Number.isNaN(Date.parse(when + 'Z'))) errs.when = 'Enter a valid UTC date and time.'
  return errs
}

const f = (n, d = 2) => n.toFixed(d)

function BodyDetails({ name, b }) {
  return (
    <div className="card">
      <h2>{name}</h2>
      <dl>
        <dt>Azimuth</dt><dd>{f(b.azimuth_deg)}°</dd>
        <dt>Elevation</dt><dd>{f(b.elevation_deg)}° {b.elevation_deg < 0 && <em>(below horizon)</em>}</dd>
        <dt>Distance</dt><dd>{Math.round(b.distance_km).toLocaleString()} km</dd>
        <dt>Angular radius</dt><dd>{f(b.angular_radius_deg, 3)}°</dd>
      </dl>
    </div>
  )
}

export default function App() {
  const [form, setForm] = useState(DEFAULTS)
  const [errors, setErrors] = useState({})
  const [status, setStatus] = useState('idle') // idle | loading | error | done
  const [error, setError] = useState('')
  const [data, setData] = useState(null)
  const [selected, setSelected] = useState('sun')
  const ctrl = useRef(null)

  useEffect(() => () => ctrl.current?.abort(), [])

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    const errs = validate(form)
    setErrors(errs)
    if (Object.keys(errs).length) return
    ctrl.current?.abort()
    ctrl.current = new AbortController()
    setStatus('loading')
    setError('')
    try {
      const when = form.when.length === 16 ? form.when + ':00' : form.when
      const res = await fetchPositions(
        { lat: Number(form.lat), lon: Number(form.lon), timestampUtc: when + 'Z' },
        ctrl.current.signal,
      )
      setData(res)
      setStatus('done')
    } catch (err) {
      if (err.name === 'AbortError') return
      setError(err.message)
      setStatus('error')
    }
  }

  const loading = status === 'loading'
  return (
    <main className="app">
      <header>
        <h1>Lunar Skyline</h1>
        <p>Where the Sun and Earth appear in the sky from a point on the Moon.</p>
      </header>

      <form onSubmit={submit} noValidate>
        <label>
          Latitude (°)
          <input inputMode="decimal" value={form.lat} onChange={set('lat')} aria-invalid={!!errors.lat} aria-describedby="e-lat" />
          <span id="e-lat" className="err">{errors.lat}</span>
        </label>
        <label>
          Longitude east (°)
          <input inputMode="decimal" value={form.lon} onChange={set('lon')} aria-invalid={!!errors.lon} aria-describedby="e-lon" />
          <span id="e-lon" className="err">{errors.lon}</span>
        </label>
        <label>
          Date and time (UTC)
          <input type="datetime-local" step="60" value={form.when} onChange={set('when')} aria-invalid={!!errors.when} aria-describedby="e-when" />
          <span id="e-when" className="err">{errors.when}</span>
        </label>
        <button type="submit" disabled={loading}>{loading ? 'Calculating…' : 'Show sky'}</button>
      </form>

      <div role="status" aria-live="polite">
        {status === 'error' && <p className="banner">{error}</p>}
        {loading && <p className="muted">Querying ephemeris…</p>}
      </div>

      {data && (
        <section className={`result${loading ? ' stale' : ''}`}>
          <SkyChart data={data} selected={selected} onSelect={setSelected} />
          <div className="details">
            <BodyDetails name={selected === 'sun' ? 'Sun' : 'Earth'} b={data[selected]} />
            <p className="muted">
              {data.timestamp_utc} · {f(data.site.latitude_deg)}°, {f(data.site.longitude_deg_east)}°E. Azimuth is clockwise from
              lunar north; elevation is relative to the mathematical horizon (no terrain). Marker sizes are not to scale.
            </p>
          </div>
        </section>
      )}
    </main>
  )
}

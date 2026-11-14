import { useEffect, useRef, useState } from 'react'
import { fetchSeries } from './api'
import SkyChart from './SkyChart'
import './App.css'

const DEFAULTS = { lat: '-89.5', lon: '223', when: '2027-03-14T00:00', hours: 24 }
const RANGES = [[24, '24 hours'], [72, '72 hours'], [168, '7 days']]
const SPEEDS = [1, 5, 20]
const STEP_MINUTES = 60
const BASE_TICK_MS = 1000 // one cached sample per second at 1x

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
const fmtUtc = (t) => t.replace('T', ' ').replace(/(\.\d+)?(Z|\+00:00)?$/, '') + ' UTC'

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
  const [series, setSeries] = useState(null)
  const [submitted, setSubmitted] = useState(null) // form values that produced `series`
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [selected, setSelected] = useState('sun')
  const ctrl = useRef(null)

  useEffect(() => () => ctrl.current?.abort(), [])

  const last = series ? series.samples.length - 1 : 0
  const stale =
    !!submitted &&
    (submitted.lat !== form.lat || submitted.lon !== form.lon || submitted.when !== form.when || submitted.hours !== form.hours)

  const isPlaying = playing && idx < last // auto-stops at the final sample

  useEffect(() => {
    if (!isPlaying) return
    const id = setInterval(() => setIdx((i) => Math.min(i + 1, last)), BASE_TICK_MS / speed)
    return () => clearInterval(id)
  }, [isPlaying, speed, last])

  const set = (k) => (e) => {
    setPlaying(false)
    setForm((p) => ({ ...p, [k]: k === 'hours' ? Number(e.target.value) : e.target.value }))
  }

  const togglePlay = () => {
    if (isPlaying) return setPlaying(false)
    if (idx >= last) setIdx(0)
    setPlaying(true)
  }
  const step = (d) => {
    setPlaying(false)
    setIdx((i) => Math.max(0, Math.min(last, i + d)))
  }

  async function submit(e) {
    e.preventDefault()
    setPlaying(false)
    const errs = validate(form)
    setErrors(errs)
    if (Object.keys(errs).length) return
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    setStatus('loading')
    setError('')
    setSeries(null) // never show results that belong to different inputs
    setSubmitted(null)
    try {
      const when = form.when.length === 16 ? form.when + ':00' : form.when
      const res = await fetchSeries(
        { lat: Number(form.lat), lon: Number(form.lon), startUtc: when + 'Z', hours: form.hours, stepMinutes: STEP_MINUTES },
        c.signal,
      )
      if (c.signal.aborted) return
      setSeries(res)
      setSubmitted({ ...form })
      setIdx(0)
      setStatus('done')
    } catch (err) {
      if (err.name === 'AbortError') return
      setError(err.message)
      setStatus('error')
    }
  }

  const sample = series?.samples[idx]
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
          Start date and time (UTC)
          <input type="datetime-local" step="60" value={form.when} onChange={set('when')} aria-invalid={!!errors.when} aria-describedby="e-when" />
          <span id="e-when" className="err">{errors.when}</span>
        </label>
        <label>
          Range
          <select value={form.hours} onChange={set('hours')}>
            {RANGES.map(([h, t]) => <option key={h} value={h}>{t}</option>)}
          </select>
          <span className="err" />
        </label>
        <button type="submit" disabled={loading}>{loading ? 'Calculating…' : 'Show sky'}</button>
      </form>

      <div role="status" aria-live="polite">
        {status === 'error' && <p className="banner">{error}</p>}
        {loading && <p className="muted">Querying ephemeris…</p>}
      </div>

      {series && (
        <section>
          {stale && <p className="banner" role="alert">Inputs changed. These results are stale — press “Show sky” to recalculate.</p>}
          <div className={`result${stale ? ' stale' : ''}`}>
            <SkyChart data={sample} selected={selected} onSelect={setSelected} />
            <div className="details">
              <BodyDetails name={selected === 'sun' ? 'Sun' : 'Earth'} b={sample[selected]} />
              <p className="muted">
                {f(series.site.latitude_deg)}°, {f(series.site.longitude_deg_east)}°E. Azimuth is clockwise from lunar north;
                elevation is relative to the mathematical horizon (no terrain). Marker sizes are not to scale.
              </p>
            </div>
          </div>
          <div className="timeline" role="group" aria-label="Time explorer">
            <p className="sampling">
              <strong>Sampled every {series.step_minutes} min</strong> · {series.samples.length} samples · positions are discrete
              SPICE samples, not continuously calculated.
            </p>
            <p className="stamp">
              <time dateTime={sample.timestamp_utc}>{fmtUtc(sample.timestamp_utc)}</time> · sample {idx + 1} of {series.samples.length}
            </p>
            <input
              type="range" min={0} max={last} step={1} value={idx} disabled={stale}
              aria-label="Timeline sample"
              aria-valuetext={`${fmtUtc(sample.timestamp_utc)}, sample ${idx + 1} of ${series.samples.length}`}
              onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)) }}
            />
            <div className="controls">
              <button type="button" onClick={() => step(-1)} disabled={stale || idx === 0} aria-label="Previous sample">⏮</button>
              <button type="button" onClick={togglePlay} disabled={stale}>
                {isPlaying ? '⏸ Pause' : idx >= last ? '↻ Restart' : '▶ Play'}
              </button>
              <button type="button" onClick={() => step(1)} disabled={stale || idx === last} aria-label="Next sample">⏭</button>
              <span className="speeds" role="group" aria-label="Playback speed">
                {SPEEDS.map((v) => (
                  <button
                    type="button" key={v} aria-pressed={speed === v} className={speed === v ? 'on' : undefined}
                    disabled={stale} onClick={() => setSpeed(v)}
                  >
                    {v}x
                  </button>
                ))}
              </span>
            </div>
          </div>
        </section>
      )}
    </main>
  )
}

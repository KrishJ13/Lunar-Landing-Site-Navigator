import { useEffect, useMemo, useState } from 'react'
import { stepTime } from './sequence.js'

const SPEEDS = [2, 8, 24, 60] // time steps per second

/**
 * Timeline for the sunlight sequence: slider, play/pause, speed and step
 * buttons. Every view reads the same step, so the Sun, Earth, sky chart,
 * lighting and shadows move together. Nothing is fetched while playing.
 */
export default function Timeline({ result, step, onStep }) {
  const { times } = result.header
  const count = times.count
  const last = count - 1
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(8)
  const perDay = Math.max(1, Math.round((24 * 60) / times.step_minutes))
  const siteLit = useMemo(() => shareSunlit(result), [result])

  useEffect(() => {
    if (!playing) return undefined
    const id = setInterval(() => onStep((k) => (k >= last ? 0 : k + 1)), 1000 / speed)
    return () => clearInterval(id)
  }, [playing, speed, last, onStep])

  const go = (k) => { setPlaying(false); onStep(Math.max(0, Math.min(last, k))) }
  const sunEl = result.arrays.sun_elevation_deg[step]
  const earthEl = result.arrays.earth_elevation_deg[step]

  return (
    <section className="v2-timeline" aria-label="Timeline">
      <div className="v2-timeline-head">
        <strong className="v2-timeline-time">{stepTime(times, step)} UTC</strong>
        <span className="v2-muted">
          step {step + 1} of {count} · every {fmtStep(times.step_minutes)} · Sun {sunEl.toFixed(2)}° · Earth {earthEl.toFixed(2)}° ·
          {' '}{(siteLit[step] * 100).toFixed(1)} % of the site sunlit
        </span>
      </div>
      <input className="v2-timeline-slider" type="range" min={0} max={last} value={step}
        aria-label="Time step" aria-valuetext={`${stepTime(times, step)} UTC`}
        onChange={(e) => go(Number(e.target.value))} />
      <SiteChart result={result} siteLit={siteLit} step={step} onPick={go} />
      <div className="v2-controls">
        <button type="button" onClick={() => go(step - perDay)} aria-label="Back one day">« day</button>
        <button type="button" onClick={() => go(step - 1)} aria-label="Back one step">‹ step</button>
        <button type="button" className="v2-play" onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Play'}</button>
        <button type="button" onClick={() => go(step + 1)} aria-label="Forward one step">step ›</button>
        <button type="button" onClick={() => go(step + perDay)} aria-label="Forward one day">day »</button>
        <label>
          Speed{' '}
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((v) => <option key={v} value={v}>{v} steps/s ({fmtStep(v * times.step_minutes)} per s)</option>)}
          </select>
        </label>
      </div>
    </section>
  )
}

function fmtStep(minutes) {
  if (minutes < 60) return `${minutes} min`
  if (minutes < 48 * 60) return `${+(minutes / 60).toFixed(1)} h`
  return `${+(minutes / 1440).toFixed(1)} days`
}

/** Mean fraction of the Sun seen over the site disc, per step. */
function shareSunlit({ header, arrays }) {
  const nodes = header.grid.nx * header.grid.ny
  const count = header.times.count
  const cells = []
  for (let i = 0; i < nodes; i++) if (arrays.in_disc[i]) cells.push(i)
  const out = new Float32Array(count)
  for (let k = 0; k < count; k++) {
    let sum = 0
    const base = k * nodes
    for (const i of cells) sum += arrays.lit[base + i]
    out[k] = sum / cells.length / 255
  }
  return out
}

/** Share of the site sunlit and the Sun's and Earth's elevation over the period; click to jump. */
function SiteChart({ result, siteLit, step, onPick }) {
  const W = 800
  const H = 110
  const count = result.header.times.count
  const x = (k) => (count > 1 ? (k / (count - 1)) * W : 0)
  const { sun_elevation_deg: sun, earth_elevation_deg: earth } = result.arrays
  let lo = 0
  let hi = 0
  for (let k = 0; k < count; k++) {
    lo = Math.min(lo, sun[k], earth[k])
    hi = Math.max(hi, sun[k], earth[k])
  }
  const yEl = (v) => H - 4 - ((v - lo) / Math.max(hi - lo, 1e-6)) * (H - 8)
  const path = (f) => {
    let d = ''
    const stride = Math.max(1, Math.floor(count / 1600))
    for (let k = 0; k < count; k += stride) d += `${k ? 'L' : 'M'}${x(k).toFixed(1)},${f(k).toFixed(1)}`
    return d
  }
  return (
    <figure className="v2-illum-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label="Share of the site sunlit, and the Sun's and Earth's elevation, over the period. Click to jump."
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          onPick(Math.round(((e.clientX - box.left) / box.width) * (count - 1)))
        }}>
        <line x1="0" x2={W} y1={yEl(0)} y2={yEl(0)} stroke="rgba(255,255,255,0.25)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d={path((k) => yEl(earth[k]))} fill="none" stroke="#4c8dff" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        <path d={path((k) => yEl(sun[k]))} fill="none" stroke="#f5b301" strokeWidth="1.2" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        <path d={path((k) => H - 4 - siteLit[k] * (H - 8))} fill="none" stroke="#f59a1b" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
        <line x1={x(step)} x2={x(step)} y1="0" y2={H} stroke="#fff" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="v2-muted">
        <span style={{ color: '#f59a1b' }}>━</span> share of the site sunlit (0–100 %) ·{' '}
        <span style={{ color: '#f5b301' }}>┄</span> Sun elevation · <span style={{ color: '#4c8dff' }}>━</span> Earth
        elevation ({lo.toFixed(1)}° to {hi.toFixed(1)}°; white line 0°) · click the chart to jump
      </figcaption>
    </figure>
  )
}

import SkyChart from './SkyChart.jsx'
import { SPEEDS } from '../lib/usePlayback.js'

const f = (n, d = 2) => n.toFixed(d)
const fmtUtc = (t) => t.replace('T', ' ').replace(/(\.\d+)?(Z|\+00:00)?$/, '') + ' UTC'

function BodyDetails({ name, b, hidden }) {
  return (
    <div className="card">
      <h3>{name}</h3>
      <dl className="body-facts">
        <dt>Azimuth</dt><dd>{f(b.azimuth_deg)}°</dd>
        <dt>Elevation</dt>
        <dd>
          {f(b.elevation_deg)}° {b.elevation_deg < 0 && <em>(below horizon)</em>}
          {b.elevation_deg >= 0 && hidden && <em>(behind terrain)</em>}
        </dd>
        <dt>Distance</dt><dd>{Math.round(b.distance_km).toLocaleString()} km</dd>
        <dt>Angular radius</dt><dd>{f(b.angular_radius_deg, 3)}°</dd>
      </dl>
    </div>
  )
}

/**
 * Sun/Earth for one tile: sky chart, readout and time-series playback. All values come from the
 * cached SPICE series; moving the slider or playing never calls the API.
 */
export default function SkyPanel({ series, playback, selected, onSelect, hiddenByTerrain }) {
  const { idx, last, isPlaying, speed } = playback
  const sample = series.samples[idx]
  const n = series.samples.length
  return (
    <section className="sky-panel" aria-label="Sun and Earth">
      <h2>Sun and Earth</h2>
      <div className="sky-result">
        <SkyChart data={sample} selected={selected} onSelect={onSelect} />
        <div className="details">
          <BodyDetails name={selected === 'sun' ? 'Sun' : 'Earth'} b={sample[selected]} hidden={hiddenByTerrain?.[selected]} />
          <p className="muted small">
            Observer {f(series.site.latitude_deg)}°, {f(series.site.longitude_deg_east)}°E, {Math.round(series.site.elevation_m).toLocaleString()} m
            above the 1737.4 km reference sphere (ground + eye height). Azimuth is clockwise from lunar north; elevation is above the
            local horizontal plane. The sky chart ignores terrain; the first-person view marks bodies behind terrain. Marker sizes in
            the chart are not to scale.
          </p>
        </div>
      </div>
      <div className="timeline" role="group" aria-label="Time explorer">
        <p className="sampling">
          <strong>Sampled every {series.step_minutes} min</strong> · {n} samples · discrete SPICE samples, not continuously calculated.
        </p>
        <p className="stamp">
          <time dateTime={sample.timestamp_utc}>{fmtUtc(sample.timestamp_utc)}</time> · sample {idx + 1} of {n}
        </p>
        <input
          type="range" min={0} max={last} step={1} value={idx}
          aria-label="Timeline sample"
          aria-valuetext={`${fmtUtc(sample.timestamp_utc)}, sample ${idx + 1} of ${n}`}
          onChange={(e) => playback.seek(Number(e.target.value))}
        />
        <div className="controls">
          <button type="button" onClick={() => playback.seek(idx - 1)} disabled={idx === 0} aria-label="Previous sample">⏮</button>
          <button type="button" onClick={playback.toggle}>
            {isPlaying ? '⏸ Pause' : idx >= last ? '↻ Restart' : '▶ Play'}
          </button>
          <button type="button" onClick={() => playback.seek(idx + 1)} disabled={idx === last} aria-label="Next sample">⏭</button>
          <span className="speeds" role="group" aria-label="Playback speed">
            {SPEEDS.map((v) => (
              <button
                type="button" key={v} aria-pressed={speed === v} className={speed === v ? 'on' : undefined}
                onClick={() => playback.setSpeed(v)}
              >
                {v}x
              </button>
            ))}
          </span>
        </div>
      </div>
    </section>
  )
}

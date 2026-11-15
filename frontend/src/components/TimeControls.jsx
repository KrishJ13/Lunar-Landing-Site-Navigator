import { SPEEDS } from '../lib/usePlayback.js'
import { formatRate, formatUtc } from '../lib/celestial.js'
import VisibilityBars from './VisibilityBars.jsx'

/**
 * UTC timeline and playback for one site. Moving the slider or playing only steps through
 * the cached SPICE samples (no API calls); each step updates the markers, readouts and
 * Find buttons together.
 */
export default function TimeControls({ series, playback, assessment }) {
  const { idx, last, isPlaying, speed } = playback
  const samples = series.samples
  const sample = samples[idx]
  const n = samples.length
  const stamp = formatUtc(sample.timestamp_utc)
  const [date, time] = stamp.split(' ')
  return (
    <section className="timeline" aria-label="UTC timeline">
      <div className="timeline-head">
        <p className="stamp">
          <time dateTime={sample.timestamp_utc}>
            <span className="stamp-time">{time}</span> <span className="stamp-zone">UTC</span>
            <span className="stamp-date">{date}</span>
          </time>
        </p>
        <p className="muted small sampling">
          Sample {idx + 1} of {n} · every {series.step_minutes} min · discrete SPICE samples
        </p>
      </div>

      <input
        type="range"
        min={0}
        max={last}
        step={1}
        value={idx}
        aria-label="Observation time (UTC)"
        aria-valuetext={`${stamp}, sample ${idx + 1} of ${n}`}
        onChange={(e) => playback.seek(Number(e.target.value))}
      />
      {assessment && <VisibilityBars assessment={assessment} idx={idx} onSeek={playback.seek} />}
      <div className="timeline-ends muted small" aria-hidden="true">
        <span>{formatUtc(samples[0].timestamp_utc)}</span>
        <span>{formatUtc(samples[last].timestamp_utc)}</span>
      </div>

      <div className="controls">
        <button type="button" onClick={() => playback.seek(idx - 1)} disabled={idx === 0} aria-label="Previous sample">
          ⏮
        </button>
        <button type="button" className="primary" onClick={playback.toggle}>
          {isPlaying ? '⏸ Pause' : idx >= last ? '↻ Restart' : '▶ Play'}
        </button>
        <button type="button" onClick={() => playback.seek(idx + 1)} disabled={idx === last} aria-label="Next sample">
          ⏭
        </button>
        <span className="speeds" role="group" aria-label="Playback speed">
          {SPEEDS.map((v) => (
            <button
              type="button"
              key={v}
              aria-pressed={speed === v}
              aria-label={`${v}x speed, ${formatRate(series.step_minutes, v)} of simulated time`}
              title={`${formatRate(series.step_minutes, v)} of simulated time`}
              onClick={() => playback.setSpeed(v)}
            >
              {v}×
            </button>
          ))}
        </span>
        <span className="muted small rate" aria-live="off">
          {isPlaying ? 'Playing' : 'Rate'}: {formatRate(series.step_minutes, speed)}
        </span>
      </div>
    </section>
  )
}

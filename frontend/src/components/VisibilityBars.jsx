import { memo } from 'react'
import { STATUS } from '../lib/celestial.js'

const ROWS = [
  ['sun', 'Sun'],
  ['earth', 'Earth'],
]

/** Collapse per-sample states into runs so a 7-day window draws a handful of segments. */
function runs(states) {
  const out = []
  for (let i = 0; i < states.length; i++) {
    const last = out[out.length - 1]
    if (last && last.state === states[i]) last.length++
    else out.push({ state: states[i], start: i, length: 1 })
  }
  return out
}

/**
 * Terrain-aware Sun and Earth visibility across the whole window, one segment per run of
 * equal states, with a cursor at the selected time. Clicking a bar seeks there (the slider
 * above is the keyboard control for the same time).
 */
function VisibilityBars({ assessment, idx, onSeek }) {
  const n = assessment.count
  const pick = (event) => {
    const r = event.currentTarget.getBoundingClientRect()
    onSeek(Math.min(n - 1, Math.max(0, Math.floor(((event.clientX - r.left) / r.width) * n))))
  }
  return (
    <div className="vis-bars">
      {ROWS.map(([key, label]) => (
        <div className={`vis-row vis-${key}`} key={key}>
          <span className="vis-label">{label}</span>
          <div
            className="vis-track"
            role="img"
            aria-label={`${label} visibility over the window: ${summarise(assessment.states[key])}`}
            onClick={pick}
          >
            {runs(assessment.states[key]).map((run) => (
              <span
                key={run.start}
                className={`vis-seg seg-${run.state}`}
                style={{ left: `${(run.start / n) * 100}%`, width: `${(run.length / n) * 100}%` }}
                title={STATUS[run.state].text}
              />
            ))}
            <span className="vis-cursor" style={{ left: `${((idx + 0.5) / n) * 100}%` }} aria-hidden="true" />
          </div>
        </div>
      ))}
      <ul className="vis-key" aria-label="Bar colours">
        <li>
          <span className="sw sw-clear" /> Above terrain
        </li>
        <li>
          <span className="sw sw-partial" /> Partly behind terrain
        </li>
        <li>
          <span className="sw sw-blocked" /> Behind terrain or below horizon
        </li>
        <li>
          <span className="sw sw-unknown" /> Terrain unknown
        </li>
      </ul>
    </div>
  )
}

function summarise(states) {
  const counts = {}
  for (const s of states) counts[s] = (counts[s] ?? 0) + 1
  return Object.entries(counts)
    .map(([s, c]) => `${STATUS[s].text} in ${c} of ${states.length} samples`)
    .join('; ')
}

export default memo(VisibilityBars)

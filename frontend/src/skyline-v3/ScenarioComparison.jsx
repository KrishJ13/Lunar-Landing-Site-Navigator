import { SLOTS, clearScenario, siteLabel, siteUrl } from '../lib/journey.js'
import { formatDuration, formatShare } from './assessment.js'

const utc = (iso) => iso.slice(0, 16).replace('T', ' ')

// [label, value(metrics), format(value, metrics), higher is better]. Each row is
// compared on its own; there is deliberately no combined score.
const ROWS = [
  ['Sun in view', (m) => m.sun.visibleShare, formatShare, true],
  ['Longest darkness', (m) => m.sun.longestBlockedHours, (v, m) => formatDuration(v, m.sun.longestBlockedOpen), false],
  ['Earth in view', (m) => m.earth.visibleShare, formatShare, true],
  ['Earth whole disc in view', (m) => m.earth.fullShare, formatShare, true],
  ['Longest Earth blackout', (m) => m.earth.longestBlockedHours, (v, m) => formatDuration(v, m.earth.longestBlockedOpen), false],
  ['Sun and Earth together', (m) => m.bothShare, formatShare, true],
  ['Landing site sunlit (mean)', (m) => m.site.meanSunlit, formatShare, true],
]

/** Side-by-side metrics for saved Scenarios A and B (each with its own site and window). */
export default function ScenarioComparison({ scenarios, savedReport = false }) {
  const saved = SLOTS.filter((slot) => scenarios[slot])
  if (!saved.length || (!savedReport && saved.length < 2)) return null
  const both = saved.length === 2
  const [a, b] = both ? [scenarios.A.metrics, scenarios.B.metrics] : []
  const windowsDiffer = both && (a.windowHours !== b.windowHours || a.stepMinutes !== b.stepMinutes)
  return (
    <section className="sk-compare" id={savedReport ? 'saved-scenarios' : 'compare'} aria-label={savedReport ? 'Saved scenarios' : 'Compare scenarios'}>
      <div className="sk-section-head">
        <div>
          <h2>{savedReport ? 'Saved scenarios' : 'Compare scenarios'}</h2>
          <p className="v2-muted v2-note">
            {both
              ? 'Bold marks the more favourable value for each playback-sampled metric.'
              : `Choose another site on the globe, or another date here, and save it as Scenario ${saved[0] === 'A' ? 'B' : 'A'} to compare.`}
          </p>
        </div>
      </div>
      <div className="sk-table-scroll">
        <table className="sk-compare-table">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              {saved.map((slot) => {
                const s = scenarios[slot]
                return (
                  <th scope="col" key={slot}>
                    <span className={`sk-slot-tag sk-slot-${slot}`}>{slot}</span>
                    <span className="sk-cmp-site">{siteLabel(s.site)}</span>
                    <span className="sk-cmp-sub">
                      {s.site.lat.toFixed(4)}°, {s.site.lon.toFixed(4)}°E · {s.site.diameterKm} km
                    </span>
                    <span className="sk-cmp-sub">
                      {utc(s.metrics.startUtc)} UTC · {formatDuration(s.metrics.windowHours)} · every{' '}
                      {formatDuration(s.metrics.stepMinutes / 60)}
                    </span>
                    {savedReport && <span className="sk-cmp-actions">
                      <a href={siteUrl(s.site, s.time)}>Open</a>
                      <button type="button" className="sk-link-btn" onClick={() => clearScenario(slot)}>Remove</button>
                    </span>}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([label, get, format, higher]) => {
              const values = saved.map((slot) => get(scenarios[slot].metrics))
              const better = both && values[0] !== values[1]
                ? (higher ? values[0] > values[1] : values[0] < values[1]) ? 0 : 1
                : -1
              return (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  {saved.map((slot, i) => (
                    <td key={slot} className={i === better ? 'is-better' : undefined}>
                      {format(values[i], scenarios[slot].metrics)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {windowsDiffer && (
        <p className="v2-muted v2-note">
          The two windows differ in length or step. Shares of time compare directly; durations are capped by each
          window and resolved to each step.
        </p>
      )}
    </section>
  )
}

import { formatUtc } from '../lib/celestial.js'
import { formatDuration, formatShare } from '../lib/assessment.js'

// Each row: label, value getter (for "which is better"), formatter, and whether more is better.
// No combined score: each metric is compared on its own.
const ROWS = [
  ['Sunlight (Sun above terrain)', (a) => a.sun.clearFraction, formatShare, true, 'sun'],
  ['Longest darkness', (a) => a.sun.longestBlockedHours, (v, a) => formatDuration(v, a.sun.longestBlockedOpen), false, 'sun'],
  ['Earth line of sight', (a) => a.earth.clearFraction, formatShare, true, 'earth'],
  ['Longest Earth blackout', (a) => a.earth.longestBlockedHours, (v, a) => formatDuration(v, a.earth.longestBlockedOpen), false, 'earth'],
  ['Sun and Earth together', (a) => a.bothFraction, formatShare, true, 'both'],
]

/** Side-by-side numbers for the two open sites (each with its own place and window). */
export default function ComparisonTable({ summaries }) {
  const ready = summaries.filter((s) => s.assessment)
  if (ready.length < 2) return null
  const windowsDiffer = ready[0].assessment.windowHours !== ready[1].assessment.windowHours
  return (
    <section className="comparison" aria-labelledby="comparison-title">
      <div className="comparison-head">
        <h2 id="comparison-title">Side-by-side comparison</h2>
        <p className="muted small">
          Terrain-aware, from each site&apos;s own SPICE window. <span className="better-key">Bold</span> marks the more
          favourable value in each row; there is no overall score.
        </p>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              {ready.map((s) => (
                <th scope="col" key={s.label}>
                  <span className="tile-label">{s.label}</span>
                  <span className="cmp-where">{s.where}</span>
                  <span className="cmp-window muted">
                    {formatUtc(s.startUtc)} · {formatDuration(s.assessment.windowHours)} · eye {s.eyeM} m
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([label, get, format, moreIsBetter, tone]) => {
              const values = ready.map((s) => get(s.assessment))
              const comparable = values.every((v) => v != null) && values[0] !== values[1]
              const best = comparable ? (moreIsBetter === values[0] > values[1] ? 0 : 1) : -1
              return (
                <tr key={label} className={`row-${tone}`}>
                  <th scope="row">{label}</th>
                  {ready.map((s, i) => (
                    <td key={s.label} className={i === best ? 'better' : undefined}>
                      {format(values[i], s.assessment)}
                      {i === best && <span className="sr-only"> (more favourable)</span>}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      <p className="muted small">
        Modelled geometric visibility at {ready[0].assessment.stepHours * 60}-min sampling; not a guarantee of solar power or
        communications availability.
      </p>
      </div>
      {windowsDiffer && (
        <p className="muted small">The two windows have different lengths, so compare durations with care.</p>
      )}
    </section>
  )
}

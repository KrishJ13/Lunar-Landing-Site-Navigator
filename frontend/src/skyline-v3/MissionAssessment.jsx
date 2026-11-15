import { useMemo } from 'react'
import ScenarioSaveActions from './ScenarioSaveActions.jsx'
import { VISIBLE, formatDuration, formatShare, nextChange, runs } from './assessment.js'
import { visibilityNote } from './bodies.js'
import { stepTime } from './sequence.js'

const W = 800
const ROW = 18
const GAP = 8

/**
 * What the window means for a mission: how often the Sun and the Earth clear the
 * local terrain from the site centre, the longest gaps, and what changes next.
 * Every figure is computed from the loaded SPICE series and LOLA skyline (assessment.js).
 */
export default function MissionAssessment({ sequence, series, scenario, step, onStep, scenarios }) {
  const { metrics } = scenario
  const { times } = sequence.header
  const count = times.count
  const k = Math.min(step, count - 1)

  return (
    <section aria-label="Mission assessment">
      <div className="sk-section-head">
        <div>
          <h2>Mission assessment</h2>
          <p className="v2-muted v2-note">
            From the site centre, {metrics.eyeHeightM} m above the ground, against the terrain skyline ·{' '}
            {count.toLocaleString()} samples every {formatDuration(metrics.stepMinutes / 60)} over{' '}
            {formatDuration(metrics.windowHours)}
          </p>
        </div>
        <ScenarioSaveActions scenario={scenario} scenarios={scenarios} />
      </div>

      <div className="sk-now">
        <NowCard label="Sun" tone="sun" fractions={series.sun} k={k} times={times}
          elevation={sequence.arrays.sun_elevation_deg[k]} />
        <NowCard label="Earth" tone="earth" fractions={series.earth} k={k} times={times}
          elevation={sequence.arrays.earth_elevation_deg[k]} />
      </div>

      <VisibilityStrip series={series} count={count} step={k} onStep={onStep} times={times} />

      <dl className="sk-metrics">
        <Metric tone="sun" label="Sun in view" value={formatShare(metrics.sun.visibleShare)}
          detail="of the window, any part of the disc above the skyline" />
        <Metric tone="sun" label="Longest darkness"
          value={formatDuration(metrics.sun.longestBlockedHours, metrics.sun.longestBlockedOpen)}
          detail="Sun fully hidden or below the horizon" />
        <Metric tone="earth" label="Earth in view" value={formatShare(metrics.earth.visibleShare)}
          detail={`whole disc ${formatShare(metrics.earth.fullShare)} of the time`} />
        <Metric tone="earth" label="Longest Earth blackout"
          value={formatDuration(metrics.earth.longestBlockedHours, metrics.earth.longestBlockedOpen)}
          detail="no line of sight to any part of the Earth" />
        <Metric tone="both" label="Sun and Earth together" value={formatShare(metrics.bothShare)}
          detail="both at least partly in view" />
        <Metric tone="sun" label="Landing site sunlit" value={formatShare(metrics.site.meanSunlit)}
          detail={`mean over ${metrics.site.points.toLocaleString()} points ${Math.round(metrics.site.spacingM)} m apart, ${metrics.site.mastHeightM} m up; best point ${formatShare(metrics.site.bestPointSunlit)}`} />
      </dl>

      <details className="sk-limits">
        <summary>How these figures are made, and their limits</summary>
        <ul>
          <li>Sun and Earth positions: SPICE (DE440, light time and aberration), topocentric from the eye.</li>
          <li>
            Terrain: LOLA elevation maps, ray-cast skyline in {metrics.skylineStepDeg}° bearing samples checked up
            to {metrics.skylineRangeKm.toLocaleString()} km away. Site-wide sunlight uses the backend horizon maps (1°
            directions to 300 km) at {metrics.site.mastHeightM} m above each grid point.
          </li>
          <li>
            Durations are counted in {formatDuration(metrics.stepMinutes / 60)} steps, so they are accurate to about one
            step. &quot;≥&quot; marks a run that reaches the edge of the window and may continue beyond it.
          </li>
          <li>
            These are geometric line-of-sight results. Sunlight in view does not guarantee power generation (panel
            orientation, dust and thermal limits are not modelled), and Earth in view does not guarantee a working
            radio link (antenna pointing, ground-station coverage and link budget are not modelled).
          </li>
        </ul>
      </details>
    </section>
  )
}

function NowCard({ label, tone, fractions, k, times, elevation }) {
  const fraction = fractions[k]
  const visible = fraction > VISIBLE
  const note = visibilityNote({ elevation_deg: elevation }, fraction)
  const state = visible ? (note ? `Partly in view (${Math.round(fraction * 100)} %)` : 'In view') : capitalise(note)
  const change = nextChange(fractions.length, (i) => fractions[i] > VISIBLE, k)
  const hours = change >= 0 ? ((change - k) * times.step_minutes) / 60 : null
  return (
    <div className={`sk-now-card sk-tone-${tone}${visible ? ' is-on' : ''}`}>
      <span className="sk-now-label"><span className="sk-dot" aria-hidden="true" />{label} now</span>
      <strong>{state}</strong>
      <span className="v2-muted v2-note">
        {change >= 0
          ? `${visible ? 'Hidden' : 'In view'} from ${stepTime(times, change)} UTC (in ${formatDuration(hours)})`
          : `No change before the end of the window`}
        {' '}· elevation {elevation.toFixed(1)}°
      </span>
    </div>
  )
}

function Metric({ tone, label, value, detail }) {
  return (
    <div className={`sk-metric sk-tone-${tone}`}>
      <dt>{label}</dt>
      <dd><strong>{value}</strong><span>{detail}</span></dd>
    </div>
  )
}

/** Sun and Earth visibility through the window as two bars; click to jump. */
function VisibilityStrip({ series, count, step, onStep, times }) {
  const bars = useMemo(() => [
    ['sun', 'Sun', series.sun],
    ['earth', 'Earth', series.earth],
  ].map(([key, label, f]) => ({
    key,
    label,
    partial: runs(count, (i) => f[i] > VISIBLE),
    full: runs(count, (i) => f[i] >= 0.999),
  })), [series, count])
  const x = (i) => (i / count) * W
  const height = bars.length * ROW + (bars.length - 1) * GAP
  return (
    <figure className="sk-strip">
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img"
        aria-label="Sun and Earth visibility over the window. Filled where in view. Click to jump to a time."
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          onStep(Math.max(0, Math.min(count - 1, Math.floor(((e.clientX - box.left) / box.width) * count))))
        }}>
        {bars.map((bar, row) => {
          const y = row * (ROW + GAP)
          return (
            <g key={bar.key} className={`sk-strip-${bar.key}`}>
              <rect className="sk-strip-track" x="0" y={y} width={W} height={ROW} />
              {bar.partial.map((r) => <rect key={`p${r.start}`} className="sk-strip-partial" x={x(r.start)} y={y}
                width={Math.max(x(r.end) - x(r.start), 0.5)} height={ROW} />)}
              {bar.full.map((r) => <rect key={`f${r.start}`} className="sk-strip-full" x={x(r.start)} y={y}
                width={Math.max(x(r.end) - x(r.start), 0.5)} height={ROW} />)}
            </g>
          )
        })}
        <line x1={x(step + 0.5)} x2={x(step + 0.5)} y1="0" y2={height} className="sk-strip-now"
          vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="v2-muted v2-note">
        <span className="sk-key sk-tone-sun"><span className="sk-dot" />Sun</span>
        <span className="sk-key sk-tone-earth"><span className="sk-dot" />Earth</span>
        solid = whole disc in view, pale = partly behind terrain, empty = hidden · {stepTime(times, 0)} to{' '}
        {stepTime(times, count - 1)} UTC · click to jump
      </figcaption>
    </figure>
  )
}

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1)

import { memo } from 'react'
import { formatDuration, formatShare } from '../lib/assessment.js'

/**
 * Compact power and communication metrics for one site's window. Every number is a count over
 * the SPICE samples with LOLA terrain occlusion (lib/assessment.js); nothing is estimated.
 */
function MissionAssessment({ assessment }) {
  const { sun, earth, windowHours, stepHours } = assessment
  return (
    <section className="assessment" aria-label="Mission assessment">
      <div className="assessment-head">
        <h2>Mission assessment</h2>
        <p className="muted small">
          Over the {formatDuration(windowHours)} window · {stepHours * 60}-min samples · terrain included
        </p>
      </div>
      <div className="metrics">
        <Metric
          tone="sun"
          label="Sunlight"
          value={formatShare(sun.clearFraction)}
          note={`Sun above the terrain (full disc ${formatShare(sun.fullFraction)})`}
        />
        <Metric
          tone="sun"
          label="Longest darkness"
          value={formatDuration(sun.longestBlockedHours, sun.longestBlockedOpen)}
          note={sun.alwaysBlocked ? 'Sun hidden for the whole window' : 'Sun fully hidden, in a row'}
        />
        <Metric
          tone="earth"
          label="Earth line of sight"
          value={formatShare(earth.clearFraction)}
          note={`Direct-to-Earth possible (full disc ${formatShare(earth.fullFraction)})`}
        />
        <Metric
          tone="earth"
          label="Longest Earth blackout"
          value={formatDuration(earth.longestBlockedHours, earth.longestBlockedOpen)}
          note={earth.alwaysBlocked ? 'Earth hidden for the whole window' : 'Earth fully hidden, in a row'}
        />
      </div>
      <p className="muted small">
        Modelled geometric visibility only, sampled every {stepHours * 60} min; it does not guarantee solar power or
        communications availability, which also depend on hardware, power systems, antennas and relays.
      </p>
      {(sun.unknown > 0 || earth.unknown > 0) && (
        <p className="muted small">
          Terrain data is missing in some directions: {sun.unknown} Sun and {earth.unknown} Earth samples are left out of
          the percentages.
        </p>
      )}
      {(sun.longestBlockedOpen || earth.longestBlockedOpen) && (
        <p className="muted small">≥ means the run reaches the edge of the window, so it may last longer.</p>
      )}
    </section>
  )
}

function Metric({ tone, label, value, note }) {
  return (
    <div className={`metric metric-${tone}`}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      <span className="metric-note">{note}</span>
    </div>
  )
}

export default memo(MissionAssessment)

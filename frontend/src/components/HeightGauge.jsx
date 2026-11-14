import { formatDistance, formatHeight } from '../lib/view.js'

const W = 300
const H = 300
const PAD = { top: 16, bottom: 16, left: 24 }

/**
 * Vertical bar of heights relative to the Moon's mean level (0 m), showing
 * where you stand compared with the Moon's average and your surroundings.
 */
export default function HeightGauge({ data }) {
  const info = data.site_info
  const wide = info.surroundings[info.surroundings.length - 1]
  const sky = data.skyline
  const top = sky.terrain_m.indexOf(Math.max(...sky.terrain_m))

  const marks = [
    { label: 'Moon mean level', value: 0, kind: 'mean' },
    { label: 'Your eyes', value: info.eye_m, kind: 'eye' },
    { label: 'Ground under you', value: info.ground_m, kind: 'ground' },
    {
      label: `Highest skyline (${formatDistance(sky.distance_km[top])} away)`,
      value: sky.terrain_m[top],
      kind: 'peak',
    },
    { label: 'Highest within 10 km', value: wide.max_m, kind: 'local' },
    { label: 'Lowest within 10 km', value: wide.min_m, kind: 'local' },
  ]

  const values = marks.map((m) => m.value)
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  const pad = Math.max((hi - lo) * 0.08, 50)
  lo -= pad
  hi += pad
  const y = (v) => PAD.top + ((hi - v) / (hi - lo)) * (H - PAD.top - PAD.bottom)

  // Spread labels so they don't overlap; keep a leader line to the true height.
  const placed = [...marks].sort((a, b) => b.value - a.value)
  let lastY = -Infinity
  for (const m of placed) {
    m.labelY = Math.max(y(m.value), lastY + 14)
    lastY = m.labelY
  }

  return (
    <figure className="height-gauge">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Heights relative to the Moon's mean level">
        <rect x={PAD.left - 10} y={PAD.top} width={10} height={H - PAD.top - PAD.bottom} className="gauge-bar" />
        {/* the band of ground within 10 km */}
        <rect
          x={PAD.left - 10}
          y={y(wide.max_m)}
          width={10}
          height={Math.max(y(wide.min_m) - y(wide.max_m), 1)}
          className="gauge-local"
        />
        {placed.map((m) => (
          <g key={m.label} className={`gauge-mark ${m.kind}`}>
            <line x1={PAD.left - 14} x2={PAD.left + 2} y1={y(m.value)} y2={y(m.value)} />
            <line x1={PAD.left + 2} x2={PAD.left + 12} y1={y(m.value)} y2={m.labelY} className="leader" />
            <text x={PAD.left + 16} y={m.labelY} dominantBaseline="middle">
              <tspan className="gauge-value">{formatHeight(m.value)}</tspan>
              <tspan className="gauge-label" dx={6}>
                {m.label}
              </tspan>
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="muted small">Heights vs the Moon&apos;s mean level (radius 1,737.4 km)</figcaption>
    </figure>
  )
}

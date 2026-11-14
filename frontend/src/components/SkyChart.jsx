const R = 150 // radius of the 0-90 deg elevation dome
const MARGIN_DEG = 30 // extra ring shows bodies up to this far below the horizon
const C = R * (1 + MARGIN_DEG / 90) + 20

function project(az, el) {
  const clamped = Math.max(el, -MARGIN_DEG)
  const r = (R * (90 - clamped)) / 90
  const a = (az * Math.PI) / 180 // azimuth clockwise from north (up)
  return { x: C + r * Math.sin(a), y: C - r * Math.cos(a) }
}

const BODIES = [
  { key: 'sun', label: 'Sun', fill: '#f5b301', r: 11 },
  { key: 'earth', label: 'Earth', fill: '#3b82f6', r: 9 },
]

const DIRS = [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]]

export default function SkyChart({ data, selected, onSelect }) {
  const size = C * 2
  return (
    <svg
      className="sky"
      viewBox={`0 0 ${size} ${size}`}
      role="group"
      aria-label="Sky chart of the Sun and Earth as seen from the lunar site"
    >
      <circle cx={C} cy={C} r={R * (1 + MARGIN_DEG / 90)} className="sky-below" />
      <circle cx={C} cy={C} r={R} className="sky-dome" />
      {[30, 60].map((el) => (
        <circle key={el} cx={C} cy={C} r={(R * (90 - el)) / 90} className="sky-grid" />
      ))}
      <line x1={C - R} x2={C + R} y1={C} y2={C} className="sky-grid" />
      <line y1={C - R} y2={C + R} x1={C} x2={C} className="sky-grid" />
      {DIRS.map(([t, dx, dy]) => (
        <text key={t} x={C + dx * (R + 12)} y={C + dy * (R + 12) + 5} className="sky-dir">
          {t}
        </text>
      ))}
      <text x={C + 4} y={C - (R * 2) / 3 - 3} className="sky-tick">30° elev</text>
      <text x={C + 4} y={C - R / 3 - 3} className="sky-tick">60° elev</text>
      <circle cx={C} cy={C} r={2.5} className="sky-zenith" />
      <text x={C} y={C + 15} className="sky-note">90° Zenith</text>
      <text x={C} y={C + R - 6} className="sky-note sky-horizon-label">0° Horizon</text>
      <text x={C} y={C + R * (1 + MARGIN_DEG / 90) - 6} className="sky-note sky-below-label">Below horizon</text>
      <text x={8} y={16} className="sky-title">Elevation (°)</text>
      {BODIES.map(({ key, label, fill, r }) => {
        const b = data[key]
        const { x, y } = project(b.azimuth_deg, b.elevation_deg)
        const up = b.elevation_deg >= 0
        const act = () => onSelect(key)
        return (
          <g
            key={key}
            className={`body${selected === key ? ' selected' : ''}`}
            tabIndex={0}
            role="button"
            aria-pressed={selected === key}
            aria-label={`${label}: azimuth ${b.azimuth_deg.toFixed(1)}°, elevation ${b.elevation_deg.toFixed(1)}°${up ? '' : ', below horizon'}`}
            onClick={act}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                act()
              }
            }}
          >
            <title>{`${label}: az ${b.azimuth_deg.toFixed(1)}°, el ${b.elevation_deg.toFixed(1)}°`}</title>
            <circle cx={x} cy={y} r={r + 8} className="hit" />
            <circle
              cx={x} cy={y} r={r} fill={fill} className="marker"
              opacity={up ? 1 : 0.45}
              strokeDasharray={up ? undefined : '3 2'}
            />
            <text x={x} y={y - r - 6} className="body-label">{up ? label : `${label} (below)`}</text>
          </g>
        )
      })}
    </svg>
  )
}

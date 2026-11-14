import { useEffect, useRef, useState } from 'react'
import { angleDiff, COMPASS_POINTS, compassName } from '../lib/view.js'

/**
 * Compass tape across the top of the view, aligned with the landscape below:
 * ticks every 5° (1° at 20° FOV or narrower), degree labels every 15° (5°, or
 * 1° at 10° FOV or narrower), N/NE/E... every 45°, and the
 * current heading in the centre.
 */
export default function CompassStrip({ heading, fov }) {
  const ref = useRef(null)
  const [width, setWidth] = useState(800)

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.floor(entry.contentRect.width))))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])

  const pxPerDeg = width / fov
  const names = Object.fromEntries(COMPASS_POINTS)
  const ticks = []
  // Finer ticks when zoomed in, so a narrow view still has a scale.
  const tickStep = fov <= 20 ? 1 : 5
  const labelStep = fov <= 10 ? 1 : fov <= 20 ? 5 : 15
  for (let az = 0; az < 360; az += tickStep) {
    const d = angleDiff(az, heading)
    if (Math.abs(d) > fov / 2) continue
    const x = width / 2 + d * pxPerDeg
    const major = az % 45 === 0
    const labelled = az % labelStep === 0
    ticks.push(
      <g key={az}>
        <line x1={x} x2={x} y1={major ? 22 : labelled ? 26 : 30} y2={36} className={major ? 'tick major' : 'tick'} />
        {major && (
          <text x={x} y={16} textAnchor="middle" className="compass-name">
            {names[az]}
          </text>
        )}
        {!major && labelled && fov <= 200 && (
          <text x={x} y={18} textAnchor="middle" className="compass-deg">
            {az}
          </text>
        )}
      </g>,
    )
  }

  return (
    <div ref={ref} className="compass-strip">
      <svg width={width} height={38} aria-hidden="true">
        {ticks}
        <path d={`M${width / 2 - 6},38 L${width / 2},31 L${width / 2 + 6},38 Z`} className="heading-marker" />
      </svg>
      <div className="heading-readout" aria-live="polite">
        Facing {Math.round(heading) % 360}° {compassName(heading)}
      </div>
    </div>
  )
}

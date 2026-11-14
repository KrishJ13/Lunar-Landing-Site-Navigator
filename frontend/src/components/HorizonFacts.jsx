import { formatDistance } from '../lib/view.js'

/** "How far can I see?" facts for one view. */
export default function HorizonFacts({ data }) {
  const { smooth_horizon: smooth, skyline } = data
  const el = skyline.elevation_deg
  const above = el.filter((v) => v > 0).length / el.length
  const dist = [...skyline.distance_km].sort((a, b) => a - b)
  const hi = el.indexOf(Math.max(...el))
  return (
    <section className="facts">
      <h3>How far can I see?</h3>
      <ul>
        <li>
          On perfectly flat ground, eyes {skyline.observer_height_m} m up would see the horizon{' '}
          <strong>{formatDistance(smooth.line_of_sight_m / 1000)}</strong> away, {smooth.dip_deg.toFixed(3)}° below eye
          level (on Earth: {formatDistance(smooth.earth_line_of_sight_m / 1000)}).
        </li>
        <li>
          Here, the real skyline is formed by terrain between <strong>{formatDistance(dist[0])}</strong> and{' '}
          <strong>{formatDistance(dist[dist.length - 1])}</strong> away (median{' '}
          {formatDistance(dist[Math.floor(dist.length / 2)])}).
        </li>
        <li>
          Terrain rises above your eye level in <strong>{Math.round(above * 100)}%</strong> of directions. Highest point of
          the skyline: {el[hi].toFixed(2)}° at {skyline.azimuth_deg[hi]}°, {formatDistance(skyline.distance_km[hi])} away.
        </li>
      </ul>
    </section>
  )
}

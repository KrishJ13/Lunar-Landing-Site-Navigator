import { compassName, formatDistance, formatHeight } from '../lib/view.js'
import HeightGauge from './HeightGauge.jsx'

/** "Where you are standing": basic facts about the ground under your feet. */
export default function SitePanel({ data }) {
  const { site, site_info: info, skyline } = data
  const [near, wide] = info.surroundings
  const belowAbove = info.ground_m < 0 ? 'below' : 'above'

  return (
    <section className="site-panel" aria-label="Where you are standing">
      <div className="site-facts">
        <h2>Where you are standing</h2>
        <p className="setting">{capitalise(info.setting)}.</p>
        <dl>
          <Row label="Coordinates">
            {Math.abs(site.lat).toFixed(3)}°{site.lat < 0 ? 'S' : 'N'}, {site.lon.toFixed(3)}°E
          </Row>
          <Row label="Ground height">
            <strong>{formatHeight(info.ground_m)}</strong> — {Math.abs(info.ground_m / 1000).toFixed(2)} km {belowAbove} the
            Moon&apos;s mean level
          </Row>
          <Row label="Your eyes">
            {skyline.observer_height_m} m above the ground, at {formatHeight(info.eye_m)} vs mean level
          </Row>
          <Row label="Ground slope">
            {info.aspect_deg == null
              ? `${info.slope_deg.toFixed(1)}° (essentially level)`
              : `${info.slope_deg.toFixed(1)}°, sloping down towards ${compassName(info.aspect_deg)} (${Math.round(info.aspect_deg)}°)`}
          </Row>
          <Row label="Within 1 km">
            ground from {formatHeight(near.min_m)} to {formatHeight(near.max_m)}
          </Row>
          <Row label="Within 10 km">
            ground from {formatHeight(wide.min_m)} to {formatHeight(wide.max_m)}; highest point{' '}
            {formatDistance(wide.max_distance_m / 1000)} away to the {compassName(wide.max_azimuth_deg)};{' '}
            {formatPercent(wide.fraction_lower)} of the ground around you is lower than where you stand
          </Row>
          <Row label="Elevation data">
            NASA LOLA {site.map.name}, {site.map.pixel_size_m.toLocaleString()} m per pixel
          </Row>
        </dl>
      </div>
      <HeightGauge data={data} />
    </section>
  )
}

function Row({ label, children }) {
  return (
    <div className="fact-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** Percentage that never rounds to exactly 0% or 100% unless it is. */
function formatPercent(fraction) {
  const pct = fraction * 100
  if (pct > 0 && pct < 1) return `${pct.toFixed(1)}%`
  if (pct > 99 && pct < 100) return `${pct.toFixed(1)}%`
  return `${Math.round(pct)}%`
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

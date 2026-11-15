import { BODY_STYLE, skylineAt, visibleFraction, visibilityNote } from './bodies.js'

const deg = (v, digits = 3) => `${v.toFixed(digits)}°`

/** Sun and Earth at the chosen instant: SPICE angles and how much of each disc clears the terrain. */
export function BodyTable({ bodies, terrain }) {
  return (
    <table className="v2-bodies">
      <caption>
        Sun and Earth at {bodies.timeUtc.replace('T', ' ').replace(':00Z', '')} UTC, seen from the eye
        ({bodies.site.elevation_m.toLocaleString(undefined, { maximumFractionDigits: 2 })} m above the 1,737.4 km sphere)
      </caption>
      <thead>
        <tr>
          <th scope="col">Body</th>
          <th scope="col">Azimuth</th>
          <th scope="col">Elevation</th>
          <th scope="col">Skyline there</th>
          <th scope="col">Disc visible</th>
          <th scope="col">Angular diameter</th>
          <th scope="col">Distance</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(BODY_STYLE).map(([key, { label, colour }]) => {
          const b = bodies[key]
          const fraction = visibleFraction(b, terrain)
          const note = visibilityNote(b, fraction)
          return (
            <tr key={key}>
              <th scope="row"><span className="v2-swatch" style={{ background: colour }} />{label}</th>
              <td>{deg(b.azimuth_deg)}</td>
              <td>{deg(b.elevation_deg)}</td>
              <td>{deg(skylineAt(terrain, b.azimuth_deg))}</td>
              <td>{`${(fraction * 100).toFixed(fraction > 0 && fraction < 1 ? 1 : 0)} %`}{note && ` (${note})`}</td>
              <td>{deg(2 * b.angular_radius_deg, 4)}</td>
              <td>{Math.round(b.distance_km).toLocaleString()} km</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

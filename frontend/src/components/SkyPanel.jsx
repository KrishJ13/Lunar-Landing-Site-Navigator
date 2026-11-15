import { useState } from 'react'
import { BODIES } from '../lib/celestial.js'
import SkyChart from './SkyChart.jsx'
import StatusChip from './StatusChip.jsx'

const f = (n, d = 2) => n.toFixed(d)

function BodyCard({ body, label, b, status, selected, onSelect }) {
  return (
    <div className={`card body-card body-card-${body}${selected ? ' selected' : ''}`}>
      <h3>
        <button type="button" className="card-title" aria-pressed={selected} onClick={() => onSelect(body)}>
          <span className="body-dot" aria-hidden="true" /> {label}
        </button>
        <StatusChip status={status} />
      </h3>
      <dl className="body-facts">
        <dt>Azimuth</dt>
        <dd>{f(b.azimuth_deg)}°</dd>
        <dt>Elevation</dt>
        <dd>{f(b.elevation_deg)}°</dd>
        <dt>Distance</dt>
        <dd>{Math.round(b.distance_km).toLocaleString()} km</dd>
        <dt>Angular radius</dt>
        <dd>{f(b.angular_radius_deg, 3)}°</dd>
      </dl>
    </div>
  )
}

/**
 * Sun/Earth for one site at the selected time: sky chart and readouts. Values come from the
 * cached SPICE series, so this never calls the API.
 */
export default function SkyPanel({ sample, site, statuses }) {
  const [selected, onSelect] = useState('sun') // which body is highlighted in the chart and cards
  return (
    <section className="sky-panel" aria-label="Sun and Earth">
      <h2>Sun and Earth</h2>
      <div className="sky-result">
        <SkyChart data={sample} selected={selected} onSelect={onSelect} />
        <div className="details">
          {BODIES.map(({ key, label }) => (
            <BodyCard
              key={key}
              body={key}
              label={label}
              b={sample[key]}
              status={statuses?.[key] ?? 'pending'}
              selected={selected === key}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
      <p className="muted small">
        Observer {f(site.latitude_deg)}°, {f(site.longitude_deg_east)}°E, {Math.round(site.elevation_m).toLocaleString()} m above
        the 1737.4 km reference sphere (ground + eye height). Azimuth is clockwise from lunar north; elevation is above the local
        horizontal plane. The sky chart ignores terrain; the first-person view marks bodies behind terrain. Marker sizes in the
        chart are not to scale.
      </p>
    </section>
  )
}

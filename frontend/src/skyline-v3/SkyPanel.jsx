import { useState } from 'react'
import SkyChart from '../components/SkyChart.jsx'
import { BodyTable } from './BodyTable.jsx'

/**
 * Sun and Earth at the timeline step: the radial sky chart (azimuth around,
 * elevation inward from the 0° horizon, as in the original Lunar Skyline) and
 * the SPICE values with how much of each disc clears the skyline.
 */
export default function SkyPanel({ bodies, terrain }) {
  const [selected, setSelected] = useState('sun')
  return (
    <section className="v2-sky" aria-label="Sun and Earth">
      <div className="v2-sky-chart">
        <SkyChart data={bodies} selected={selected} onSelect={setSelected} />
        <p className="v2-muted v2-note">Sky chart ignores terrain; marker sizes are not to scale.</p>
      </div>
      <BodyTable bodies={bodies} terrain={terrain} />
    </section>
  )
}

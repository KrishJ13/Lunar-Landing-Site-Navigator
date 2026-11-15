import { useMemo } from 'react'
import { stepTime } from './sequence.js'
import { HEAT_COLORS } from './terrainRenderer.js'

const MODES = [
  ['time', 'Shadows at the timeline step'],
  ['mean', '% of time sunlit'],
  ['dark', 'Longest darkness'],
]
const heatGradient = `linear-gradient(to right, ${HEAT_COLORS.join(', ')})`
const pct = (v) => `${(v * 100).toFixed(1)} %`
const hrs = (v) => (v >= 48 ? `${(v / 24).toFixed(1)} days` : `${Math.round(v)} h`)

/**
 * Sunlight over the whole sequence: what the overhead view shows, and summary
 * figures from the horizon maps (lunar/horizon_maps.py, lunar/illumination.py).
 */
export default function IlluminationPanel({ result, mode, onMode }) {
  const stats = useMemo(() => summarise(result), [result])
  const { header } = result
  const count = header.times.count
  return (
    <section className="v2-illum">
      <h2>Sunlight over the period</h2>
      <fieldset className="v2-illum-modes">
        <legend>Overhead view shows</legend>
        {MODES.map(([key, label]) => (
          <label key={key}>
            <input type="radio" name="v2-illum-mode" value={key} checked={mode === key} onChange={() => onMode(key)} />
            {label}
          </label>
        ))}
      </fieldset>
      {mode !== 'time' && <HeatLegend mode={mode} darkMax={stats.darkMax} />}
      <dl className="v2-summary">
        <div><dt>Period</dt><dd>{stepTime(header.times, 0)} to {stepTime(header.times, count - 1)} UTC, {count.toLocaleString()} steps</dd></div>
        <div><dt>Sunlit, centre</dt><dd>{pct(stats.centreMean)} of the time; longest darkness {hrs(stats.centreDark)}</dd></div>
        <div><dt>Sunlit, best point</dt><dd>{pct(stats.best)} of the time ({stats.bestXY}); longest darkness there {hrs(stats.bestDark)}</dd></div>
        <div><dt>Across the site</dt><dd>median {pct(stats.median)}, lowest {pct(stats.worst)}</dd></div>
        <div><dt>Shadow grid</dt><dd>{cellsInDisc(result).toLocaleString()} points in the site, {Math.round(header.grid.spacing_m)} m apart, {header.site.mast_height_m} m above the ground; horizon in 1° directions to 300 km</dd></div>
        <div><dt>Time taken</dt><dd>horizon maps {header.timings_s.horizon_maps.toFixed(1)} s ({header.grid.tiles.reused} of {header.grid.tiles.tiles} tiles reused from nearby sites), sunlight {header.timings_s.illumination.toFixed(1)} s</dd></div>
      </dl>
      <p className="v2-muted v2-note">
        &quot;Sunlit&quot; counts the visible fraction of the Sun&apos;s disc, so a half-hidden Sun counts half. Darkness is a
        run of steps with less than 0.1 % of the disc visible.
      </p>
    </section>
  )
}

function cellsInDisc({ arrays }) {
  let n = 0
  for (const v of arrays.in_disc) n += v
  return n
}

function HeatLegend({ mode, darkMax }) {
  return (
    <figure className="v2-elevation-legend">
      <figcaption>{mode === 'mean' ? 'Share of the period with the Sun visible' : 'Longest continuous darkness in the period'}</figcaption>
      <div className="v2-elevation-ramp" style={{ background: heatGradient }} aria-hidden="true" />
      <div className="v2-elevation-labels">
        <span>{mode === 'mean' ? '0 %' : hrs(darkMax)}</span>
        <span>{mode === 'mean' ? '50 %' : hrs(darkMax / 2)}</span>
        <span>{mode === 'mean' ? '100 %' : '0 h'}</span>
      </div>
    </figure>
  )
}

function summarise({ header, arrays }) {
  const nodes = header.grid.nx * header.grid.ny
  const xy = arrays.node_site_xy_m // (ny, nx, 2): each node in the site's frame
  const cells = []
  for (let i = 0; i < nodes; i++) if (arrays.in_disc[i]) cells.push(i)
  const means = cells.map((i) => arrays.mean_lit[i]).sort((a, b) => a - b)
  let bestIndex = cells[0]
  let centre = cells[0]
  for (const i of cells) {
    if (arrays.mean_lit[i] > arrays.mean_lit[bestIndex]) bestIndex = i
    if (Math.hypot(xy[2 * i], xy[2 * i + 1]) < Math.hypot(xy[2 * centre], xy[2 * centre + 1])) centre = i
  }
  const bx = xy[2 * bestIndex]
  const by = xy[2 * bestIndex + 1]
  let darkMax = 0
  for (const i of cells) darkMax = Math.max(darkMax, arrays.longest_dark_h[i])
  return {
    centreMean: arrays.mean_lit[centre],
    centreDark: arrays.longest_dark_h[centre],
    best: arrays.mean_lit[bestIndex],
    bestDark: arrays.longest_dark_h[bestIndex],
    bestXY: `${(Math.abs(bx) / 1000).toFixed(2)} km ${bx >= 0 ? 'east' : 'west'}, ${(Math.abs(by) / 1000).toFixed(2)} km ${by >= 0 ? 'north' : 'south'} of the centre`,
    median: means[Math.floor(means.length / 2)],
    worst: means[0],
    darkMax: Math.max(darkMax, 1e-6),
  }
}

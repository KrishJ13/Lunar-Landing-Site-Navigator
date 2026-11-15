import { useMemo, useRef, useState } from 'react'
import { SURROUND_KM, fetchIllumination, fetchShadowField, fetchSiteTerrain } from './api.js'
import FirstPersonTerrain from './FirstPersonTerrain.jsx'
import IlluminationPanel from './IlluminationPanel.jsx'
import { enuDirection, sunVisibleBesideEarth } from './lighting.js'

const SOLAR_CONSTANT = 1361 // W/m^2 at 1 AU (IAU 2015 Resolution B3 nominal total solar irradiance)
const AU_KM = 149_597_870.7
import OverheadTerrain from './OverheadTerrain.jsx'
import { bodiesAt, seenAt } from './sequence.js'
import SiteInputForm from './SiteInputForm.jsx'
import SkyPanel from './SkyPanel.jsx'
import Timeline from './Timeline.jsx'

const VIEWS = [
  ['first-person', 'First-person 360°'],
  ['overhead', 'Overhead (orbit)'],
]

const sameSite = (a, b) => a && b && a.lat === b.lat && a.lon === b.lon && a.diameterKm === b.diameterKm &&
  a.eyeHeightM === b.eyeHeightM && a.elevationProduct === b.elevationProduct
const sameSequence = (a, b) => sameSite(a, b) && a.timeUtc === b.timeUtc && a.hours === b.hours &&
  a.stepMinutes === b.stepMinutes && a.mastHeightM === b.mastHeightM

/**
 * Lunar Skyline V3 (developer page): one landing site at a time.
 *
 * Build loads the terrain (POST /api/site/terrain) and a time sequence
 * (POST /api/site/illumination: Sun, Earth and the fraction of the Sun each
 * point of the site sees, every step). A single timeline step drives the
 * first-person view (WebGL Sun, Earth and stars; sunlight and shadows), the
 * overhead view, the sky chart and the tables. Nothing is fetched while playing.
 * Written as self-contained components so they can later move into Moon Explorer.
 */
export default function SkylineV3() {
  const [inputs, setInputs] = useState(null)
  const [terrain, setTerrain] = useState(null)
  const [sequence, setSequence] = useState(null)
  const [field, setField] = useState(null)
  const [step, setStep] = useState(0)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(null) // null, 'terrain' or 'sequence'
  const [view, setView] = useState('first-person')
  const [lightMode, setLightMode] = useState('sun')
  const [overheadMode, setOverheadMode] = useState('shadows')
  const inFlight = useRef(null)

  // Terrain and the time sequence are independent requests: run them together.
  async function build(next) {
    if (sameSequence(next, inputs) && sequence) return
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setError(null)
    const needTerrain = !sameSite(next, inputs) || !terrain
    setLoading(needTerrain ? 'terrain' : 'sequence')
    if (needTerrain) setSequence(null)
    const t0 = performance.now()
    const terrainRequest = needTerrain
      ? fetchSiteTerrain(
        { lat: next.lat, lon: next.lon, diameterKm: next.diameterKm, observerHeightM: next.eyeHeightM,
          elevationProduct: next.elevationProduct },
        controller.signal,
      ).then((t) => ({ ...t, receivedMs: performance.now() - t0 }))
      : Promise.resolve(terrain)
    const fieldRequest = needTerrain
      ? fetchShadowField({ lat: next.lat, lon: next.lon, elevationProduct: next.elevationProduct }, controller.signal)
      : Promise.resolve(field)
    const sequenceRequest = fetchIllumination({
      lat: next.lat, lon: next.lon, diameterKm: next.diameterKm, mastHeightM: next.mastHeightM,
      eyeHeightM: next.eyeHeightM, startUtc: next.timeUtc, hours: next.hours, stepMinutes: next.stepMinutes,
    }, controller.signal).then((s) => ({ ...s, receivedMs: performance.now() - t0 }))
    try {
      const [t, s, f] = await Promise.all([terrainRequest, sequenceRequest, fieldRequest])
      if (inFlight.current !== controller) return
      setTerrain(t)
      setField(f)
      setInputs(next)
      setSequence(s)
      setStep(0)
    } catch (err) {
      if (inFlight.current === controller && err.name !== 'AbortError') {
        controller.abort()
        setError(err.message)
      }
    } finally {
      if (inFlight.current === controller) setLoading(null)
    }
  }

  const k = sequence ? Math.min(step, sequence.header.times.count - 1) : 0
  const bodies = useMemo(() => (sequence ? bodiesAt(sequence, k) : null), [sequence, k])
  const seen = useMemo(() => (sequence ? seenAt(sequence, k) : null), [sequence, k])
  const lighting = useMemo(() => {
    if (lightMode !== 'sun' || !bodies) return { mode: 'fixed' }
    return {
      mode: 'sun',
      sun: enuDirection(bodies.sun.azimuth_deg, bodies.sun.elevation_deg),
      sunRadius: (bodies.sun.angular_radius_deg * Math.PI) / 180,
      sunVisible: sunVisibleBesideEarth(bodies.sun, bodies.earth),
    }
  }, [lightMode, bodies])

  // The Sun at the step for maps that need it whatever the lighting choice:
  // S(t) = 1361 W/m^2 x (1 AU / r)^2 (nominal total solar irradiance, IAU 2015 B3).
  const sunNow = useMemo(() => {
    if (!bodies) return null
    const { sun, earth } = bodies
    return {
      sun: enuDirection(sun.azimuth_deg, sun.elevation_deg),
      sunRadius: (sun.angular_radius_deg * Math.PI) / 180,
      sunVisible: sunVisibleBesideEarth(sun, earth),
      solarFlux: SOLAR_CONSTANT * (AU_KM / sun.distance_km) ** 2,
    }
  }, [bodies])

  // Steps each lattice point has been dark (< 0.1 % of the Sun visible) up to step k.
  const darkRuns = useMemo(() => (sequence ? darkRunLengths(sequence) : null), [sequence])

  // The overhead map at the step: shadows (the lighting), incident sunlight (W/m^2,
  // drawn on the GPU from the same shadows), or how long each point has been dark.
  const overlay = useMemo(() => {
    if (!sequence || overheadMode !== 'dark') return null
    const count = seen.nx * seen.ny
    const values = new Uint8Array(count)
    const periodSteps = sequence.header.times.count
    const base = k * count
    for (let i = 0; i < count; i++) {
      values[i] = Math.round(255 * (1 - Math.min(1, darkRuns[base + i] / periodSteps)))
    }
    return { ...seen, values, mode: 'heat' }
  }, [sequence, overheadMode, seen, darkRuns, k])

  return (
    <main className="v2">
      <header className="v2-header">
        <a href="./" className="v2-back">← Menu</a>
        <h1>Lunar Skyline V3 <span className="v2-badge">developer</span></h1>
        <p className="v2-muted">
          Explore the landing site from ground level, and play the Sun, Earth, sunlight and shadows through time.
        </p>
      </header>

      <SiteInputForm onSubmit={build} loading={loading !== null} />

      {loading && (
        <p className="v2-muted" role="status">
          {loading === 'terrain' ? 'Loading the landing-site terrain, 360° horizon and time sequence…'
            : 'Computing the time sequence…'}
        </p>
      )}
      {error && <p className="v2-error" role="alert">{error}</p>}

      {terrain && inputs && (
        <section className="v2-result">
          {sequence && <Timeline result={sequence} step={k} onStep={setStep} />}
          <div className="v2-tabs" role="tablist" aria-label="View">
            {VIEWS.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={view === key}
                className={view === key ? 'on' : undefined} onClick={() => setView(key)}>
                {label}
              </button>
            ))}
          </div>
          <LightingControl mode={lightMode} onChange={setLightMode} bodies={bodies} />
          <div role="tabpanel">
            {view === 'first-person' ? (
              <>
                <FirstPersonTerrain key={`${inputs.lat},${inputs.lon},${inputs.eyeHeightM}`}
                  terrain={terrain} bodies={bodies} lighting={lighting} field={field}
                  shadowHeightM={inputs.mastHeightM} />
                <p className="v2-muted v2-note">
                  {terrain.header.elevation_maps?.length
                    ? `Elevation maps near to far · ${terrain.header.elevation_maps.join(' → ')}`
                    : 'LOLA LDEM_128 for the full view · 128 pixels per degree'}
                </p>
              </>
            ) : (
              <>
                <OverheadTerrain key={`${inputs.lat},${inputs.lon},${inputs.diameterKm}`} terrain={terrain}
                  lighting={overheadMode === 'shadows' ? lighting : { mode: 'fixed' }} overlay={overlay} field={field}
                  bodies={bodies} sunNow={sunNow} intensity={overheadMode === 'intensity'}
                  shadowHeightM={inputs.mastHeightM} />
                <p className="v2-muted v2-note">
                  The amber line marks the {terrain.header.site.diameter_km} km landing site. The greyed ring around it shows
                  the terrain {SURROUND_KM} km further out, with the same shadows, for context.
                </p>
              </>
            )}
          </div>
          {bodies && <SkyPanel bodies={bodies} terrain={terrain} />}
          {sequence && (
            <IlluminationPanel result={sequence} mode={overheadMode} step={k} sunNow={sunNow}
              onMode={(m) => { setOverheadMode(m); setView('overhead') }} />
          )}
          <TerrainSummary terrain={terrain} inputs={inputs} />
        </section>
      )}
    </main>
  )
}

function LightingControl({ mode, onChange, bodies }) {
  return (
    <div className="v2-lighting">
      <fieldset>
        <legend>Lighting</legend>
        <label>
          <input type="radio" name="v2-lighting" value="sun" checked={mode === 'sun'} onChange={() => onChange('sun')} />
          Sun at the timeline step
        </label>
        <label>
          <input type="radio" name="v2-lighting" value="fixed" checked={mode === 'fixed'} onChange={() => onChange('fixed')} />
          Fixed light (terrain shape only)
        </label>
      </fieldset>
      {mode === 'sun' && (
        <p className="v2-muted v2-note">
          {bodies ? `Sun ${bodies.sun.elevation_deg.toFixed(2)}° up at azimuth ${bodies.sun.azimuth_deg.toFixed(2)}°. ` : ''}
          Sunlight uses Moon Explorer's lighting model on a uniform grey surface. Shadows are traced on the GPU for
          every visible point: a ray towards the Sun over nested height grids out to 600 km (1.5 m at your feet),
          Moon's curvature included, from a point at the shadow height set in the form (as the sunlight figures).
          Isolated elevation spikes are corrected. Shadowed ground keeps the fixed-light relief at 12 % brightness
          (not physical) so its shape stays readable.
        </p>
      )}
    </div>
  )
}

function TerrainSummary({ terrain, inputs }) {
  const { header, arrays } = terrain
  const { site, site_grid: grid, skyline } = header
  const bytes = Object.values(arrays).reduce((n, a) => n + a.byteLength, 0)
  const rows = [
    ['Site', `${inputs.siteName ?? 'Custom'} · ${site.lat.toFixed(4)}°, ${site.lon.toFixed(4)}°E`],
    ['Start (UTC)', `${inputs.timeUtc.replace('T', ' ').replace(':00Z', '')} for ${(inputs.hours / 24).toFixed(2)} days every ${inputs.stepMinutes} min (the terrain does not depend on time)`],
    ['Ground height', `${site.ground_m.toLocaleString()} m above the 1,737.4 km sphere`],
    ['Eye', `${site.eye_height_m} m above ground → ${site.eye_m.toLocaleString()} m`],
    ['Landing site', `${site.diameter_km} km across`],
    ['Site grid', `${grid.points} × ${grid.points} points, ${grid.spacing_m.toFixed(1)} m apart (${fmtMaps(grid.maps_used)})`],
    ['Local horizon', `${skyline.azimuth_step_deg}° bearing samples, terrain checked up to ${skyline.max_range_m / 1000} km away`],
    ['Data', `${(bytes / 1e6).toFixed(2)} MB decoded, received in ${(terrain.receivedMs / 1000).toFixed(2)} s`],
  ]
  return (
    <dl className="v2-summary">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function fmtMaps(used) {
  return Object.entries(used).map(([px, n]) => `${px} pixels: ${n.toLocaleString()} points`).join(', ')
}


/** Steps each lattice point has been dark (< 0.1 % of the Sun, lit byte 0) up to each step; Uint16 (T x nodes). */
function darkRunLengths({ header, arrays }) {
  const nodes = header.grid.nx * header.grid.ny
  const count = header.times.count
  const runs = new Uint16Array(count * nodes)
  for (let k = 0; k < count; k++) {
    const base = k * nodes
    for (let i = 0; i < nodes; i++) {
      runs[base + i] = arrays.lit[base + i] === 0 ? Math.min(65535, (k ? runs[base - nodes + i] : 0) + 1) : 0
    }
  }
  return runs
}

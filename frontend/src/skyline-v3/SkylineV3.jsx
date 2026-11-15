import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_HOURS, globeUrl, readJourney, siteLabel, siteUrl } from '../lib/journey.js'
import useScenarios from '../lib/useScenarios.js'
import { SURROUND_KM, fetchIllumination, fetchShadowField, fetchSiteTerrain } from './api.js'
import FirstPersonTerrain from './FirstPersonTerrain.jsx'
import IlluminationPanel from './IlluminationPanel.jsx'
import { enuDirection, sunVisibleBesideEarth } from './lighting.js'
import MissionAssessment from './MissionAssessment.jsx'
import OverheadTerrain from './OverheadTerrain.jsx'
import ScenarioComparison from './ScenarioComparison.jsx'
import { bodiesAt, seenAt } from './sequence.js'
import SiteInputForm from './SiteInputForm.jsx'
import SkyPanel from './SkyPanel.jsx'
import Timeline from './Timeline.jsx'

const SOLAR_CONSTANT = 1361 // W/m^2 at 1 AU (IAU 2015 Resolution B3 nominal total solar irradiance)
const AU_KM = 149_597_870.7

const VIEWS = [
  ['first-person', 'First-person 360°'],
  ['overhead', 'Overhead (orbit)'],
]
// Per-section client timeouts. Measured cold (first visit to a site, elevation tiles
// downloaded and cached by the backend): shadow field up to ~80 s, sunlight ~25 s,
// landscape ~5 s; repeat visits are cached and take well under 5 s.
const SECTION_TIMEOUT_MS = { landscape: 120_000, shadows: 180_000, 'sunlight timeline': 180_000 }
const SECTION_LABEL = { landscape: 'terrain', shadows: 'terrain shadows', 'sunlight timeline': 'Sun and Earth timeline' }

const sameSite = (a, b) => a && b && a.lat === b.lat && a.lon === b.lon && a.diameterKm === b.diameterKm &&
  a.eyeHeightM === b.eyeHeightM
const sameSequence = (a, b) => sameSite(a, b) && a.timeUtc === b.timeUtc && a.hours === b.hours &&
  a.stepMinutes === b.stepMinutes && a.mastHeightM === b.mastHeightM

/**
 * Skyline View (Skyline V4), the landing-site view of the app: one landing site at a time.
 * Opened from Moon Explorer with the site and time in the URL (lib/journey.js),
 * which it builds straight away; the URL follows every rebuild.
 *
 * Build loads the terrain (POST /api/site/terrain) and a time sequence
 * (POST /api/site/illumination: Sun, Earth and the fraction of the Sun each
 * point of the site sees, every step). A single timeline step drives the
 * first-person view (WebGL Sun, Earth and stars; sunlight and shadows), the
 * overhead view, the sky chart and the tables. Nothing is fetched while playing.
 */
export default function SkylineV3() {
  const [inputs, setInputs] = useState(null)
  const [terrain, setTerrain] = useState(null)
  const [sequence, setSequence] = useState(null)
  const [field, setField] = useState(null)
  const [step, setStep] = useState(0)
  const [errors, setErrors] = useState([])
  const [pending, setPending] = useState([])
  const [view, setView] = useState('first-person')
  const [lightMode, setLightMode] = useState('sun')
  const [overheadMode, setOverheadMode] = useState('shadows')
  const [failed, setFailed] = useState([])
  const [loadStart, setLoadStart] = useState(0)
  const [initial] = useState(() => readJourney(window.location.search))
  const scenarios = useScenarios()
  const inFlight = useRef(null)

  async function build(next) {
    const reuseSite = sameSite(next, inputs)
    const reuseSequence = sameSequence(next, inputs) && sequence
    const needsLandscape = !reuseSite || !terrain
    const sections = []
    if (needsLandscape) {
      sections.push(['landscape', (signal) => fetchSiteTerrain({
        lat: next.lat, lon: next.lon, diameterKm: next.diameterKm, observerHeightM: next.eyeHeightM,
      }, signal), setTerrain])
    }
    if (!reuseSite || !field) {
      sections.push(['shadows', (signal) => fetchShadowField({
        lat: next.lat, lon: next.lon,
      }, signal), setField])
    }
    if (!reuseSequence) {
      sections.push(['sunlight timeline', (signal) => fetchIllumination({
        lat: next.lat, lon: next.lon, diameterKm: next.diameterKm, mastHeightM: next.mastHeightM,
        eyeHeightM: next.eyeHeightM, startUtc: next.timeUtc, hours: next.hours, stepMinutes: next.stepMinutes,
      }, signal), setSequence])
    }
    if (!sections.length) return

    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setInputs(next)
    const site = { lat: next.lat, lon: next.lon, diameterKm: next.diameterKm, name: next.siteName }
    window.history.replaceState(null, '', siteUrl(site, {
      startUtc: next.timeUtc, hours: next.hours, stepMinutes: next.stepMinutes,
      eyeHeightM: next.eyeHeightM, mastHeightM: next.mastHeightM,
      // Keep the two-site journey in the URL while this is still the planned site.
      ...(initial.slot && initial.compare && sameCoords(next, initial.site)
        ? { slot: initial.slot, compare: initial.compare } : {}),
    }))
    if (!reuseSite) {
      setTerrain(null)
      setField(null)
    }
    if (!reuseSequence) setSequence(null)
    setStep(0)
    setErrors([])
    setFailed([])
    setLoadStart(Date.now())
    setPending(sections.map(([label]) => label))

    async function loadSection([label, load, receive]) {
      const timeout = AbortSignal.timeout(SECTION_TIMEOUT_MS[label])
      const signal = AbortSignal.any([controller.signal, timeout])
      const start = performance.now()
      try {
        const data = await load(signal)
        signal.throwIfAborted()
        if (inFlight.current === controller) receive({ ...data, receivedMs: performance.now() - start })
      } catch (err) {
        if (inFlight.current === controller) {
          const detail = timeout.aborted
            ? `No answer after ${SECTION_TIMEOUT_MS[label] / 1000} seconds. Check the backend is running, then try again.`
            : err.message
          setErrors((current) => [...current, { summary: `Could not load the ${SECTION_LABEL[label]}.`, ...explain(detail) }])
          setFailed((current) => [...current, label])
        }
      } finally {
        if (inFlight.current === controller) setPending((current) => current.filter((item) => item !== label))
      }
    }
    // Both views use the landscape response. Give it priority over the lighting requests.
    if (needsLandscape) await loadSection(sections.shift())
    if (!controller.signal.aborted) sections.forEach(loadSection)
  }

  const k = sequence ? Math.min(step, sequence.header.times.count - 1) : 0
  const bodies = useMemo(() => (sequence ? bodiesAt(sequence, k) : null), [sequence, k])
  // Without the shadow field (failed to load) the views still draw, with fixed light.
  const frameKey = terrain && (bodies || failed.includes('sunlight timeline')) &&
    (field || failed.includes('shadows')) ? inputs : null
  const seen = useMemo(() => (sequence ? seenAt(sequence, k) : null), [sequence, k])
  const lighting = useMemo(() => {
    if (lightMode !== 'sun' || !bodies || !field) return { mode: 'fixed' }
    return {
      mode: 'sun',
      sun: enuDirection(bodies.sun.azimuth_deg, bodies.sun.elevation_deg),
      sunRadius: (bodies.sun.angular_radius_deg * Math.PI) / 180,
      sunVisible: sunVisibleBesideEarth(bodies.sun, bodies.earth),
    }
  }, [lightMode, bodies, field])

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

  const site = inputs && { lat: inputs.lat, lon: inputs.lon, diameterKm: inputs.diameterKm, name: inputs.siteName }
  // Two-site journey (slot + compare in the URL): this page is Site A or Site B of the plan.
  const journey = initial.slot && initial.compare ? initial : null
  const onJourneySite = Boolean(journey && inputs && sameCoords(inputs, journey.site))
  const planA = journey ? (journey.slot === 'A' ? journey.site : journey.compare) : null
  const planB = journey ? (journey.slot === 'A' ? journey.compare : journey.site) : null
  const backTime = bodies?.timeUtc ?? inputs?.timeUtc ?? initial.startUtc
  const backHref = journey ? globeUrl(planA, backTime, planB)
    : site ? globeUrl(site, backTime) : globeUrl(initial.site, initial.startUtc)
  const loading = pending.length > 0

  return (
    <main className="v2 sk">
      <header className="sk-header">
        <a href={backHref} className="sk-back">← Back to site planner</a>
        <div className="sk-title">
          <p className="sk-eyebrow">Skyline View{journey ? ` · Site ${journey.slot}` : ''}</p>
          <h1>{site ? siteLabel(site) : 'Choose a landing site'}</h1>
          {site && (
            <p className="v2-muted">
              {inputs.lat.toFixed(4)}°, {inputs.lon.toFixed(4)}°E · {inputs.diameterKm} km site · eye {inputs.eyeHeightM} m
            </p>
          )}
        </div>
        <ScenarioTray scenarios={scenarios} />
      </header>

      {journey && <JourneyBanner journey={journey} active={onJourneySite} inputs={inputs}
        scenarios={scenarios} />}

      <SiteInputForm onSubmit={build} loading={loading} initial={initial} built={Boolean(inputs)} />

      {errors.map((error) => (
        <div className="v2-error sk-alert" role="alert" key={error.summary}>
          <strong>{error.summary}</strong> {error.message}
          {error.raw && <details><summary>Technical detail</summary><code>{error.raw}</code></details>}
        </div>
      ))}

      {!inputs && (
        <p className="sk-empty">
          Pick a landing site on the <a href={backHref}>Moon globe</a>, or enter coordinates above and press{' '}
          <strong>Show site</strong>. You will stand on the terrain and play the Sun and Earth through time.
        </p>
      )}

      {inputs && (
        <section className="v2-result">
          {loading && <LoadingNote pending={pending} since={loadStart} />}
          {sequence && <Timeline result={sequence} step={k} onStep={setStep} />}
          {terrain && <div className="sk-view-bar">
            <div className="v2-tabs" role="tablist" aria-label="View">
              {VIEWS.map(([key, label]) => (
                <button key={key} type="button" role="tab" aria-selected={view === key}
                  className={view === key ? 'on' : undefined} onClick={() => setView(key)}>
                  {label}
                </button>
              ))}
            </div>
          </div>}
          {terrain && <div role="tabpanel">
            {view === 'first-person' ? (
              <FirstPersonTerrain key={`${inputs.lat},${inputs.lon},${inputs.eyeHeightM}`}
                terrain={terrain} bodies={bodies} lighting={lighting} field={field} frameKey={frameKey}
                shadowHeightM={inputs.mastHeightM} />
            ) : (
              <>
                <OverheadTerrain key={`${inputs.lat},${inputs.lon},${inputs.diameterKm}`} terrain={terrain} frameKey={frameKey}
                  lighting={overheadMode === 'shadows' ? lighting : { mode: 'fixed' }} overlay={overlay} field={field}
                  bodies={bodies} sunNow={field ? sunNow : null} intensity={overheadMode === 'intensity' && !!field}
                  shadowHeightM={inputs.mastHeightM} />
                <p className="v2-muted v2-note">
                  The amber line marks the {terrain.header.site.diameter_km} km landing site. The greyed ring around it shows
                  the terrain {SURROUND_KM} km further out, with the same shadows, for context.
                </p>
              </>
            )}
          </div>}
          {terrain && sequence && (
            <MissionAssessment sequence={sequence} terrain={terrain} inputs={inputs} step={k} onStep={setStep}
              scenarios={scenarios} autoSaveSlot={onJourneySite ? journey.slot : null} />
          )}
          <ScenarioComparison scenarios={scenarios} />
          {terrain && bodies && (
            <details className="sk-panel">
              <summary>Sun and Earth details</summary>
              <SkyPanel bodies={bodies} terrain={terrain} />
            </details>
          )}
          {sequence && (
            <details className="sk-panel">
              <summary>Sunlight across the landing site</summary>
              <IlluminationPanel result={sequence} mode={overheadMode} step={k} sunNow={sunNow}
                onMode={(m) => { setOverheadMode(m); setView('overhead') }} />
            </details>
          )}
          {terrain && (
            <details className="sk-panel">
              <summary>Lighting model and terrain data</summary>
              <LightingControl mode={lightMode} onChange={setLightMode} bodies={frameKey ? bodies : null} />
              <p className="v2-muted v2-note">
                {terrain.header.elevation_maps?.length
                  ? `Elevation maps near to far · ${terrain.header.elevation_maps.join(' → ')}`
                  : 'LOLA LDEM_128 for the full view · 128 pixels per degree'}
              </p>
              <TerrainSummary terrain={terrain} inputs={inputs} />
            </details>
          )}
        </section>
      )}
      {!inputs && <ScenarioComparison scenarios={scenarios} />}
      <footer className="sk-footer v2-muted v2-note">
        Lunar Landing Site Navigator · NASA Space Apps 2026 · SPICE (NAIF) ephemerides · LOLA elevation (NASA PDS)
      </footer>
    </main>
  )
}

const sameCoords = (a, b) => a && b && a.lat.toFixed(5) === b.lat.toFixed(5) && a.lon.toFixed(5) === b.lon.toFixed(5)

/** Progress through a two-site comparison: Site A, then Site B, then the table. */
function JourneyBanner({ journey, active, inputs, scenarios }) {
  const { slot, site, compare } = journey
  const saved = scenarios[slot]
  const done = Boolean(active && saved && sameCoords(saved.site, site) && saved.time?.startUtc === inputs?.timeUtc)
  const time = {
    startUtc: inputs?.timeUtc ?? journey.startUtc, hours: inputs?.hours ?? journey.hours ?? DEFAULT_HOURS,
    stepMinutes: inputs?.stepMinutes ?? journey.stepMinutes, eyeHeightM: inputs?.eyeHeightM, mastHeightM: inputs?.mastHeightM,
  }
  let body
  if (inputs && !active) {
    body = <span>You changed the site, so this run is not part of the comparison. Save it manually below if needed.</span>
  } else if (!done) {
    body = <span><strong>Comparing two sites · Site {slot} of 2.</strong> Results are saved automatically once they load.</span>
  } else if (slot === 'A') {
    body = (
      <>
        <span><strong>Site A saved.</strong> Next, load Site B with the same time window.</span>
        <a className="sk-journey-cta" href={siteUrl(compare, { ...time, slot: 'B', compare: site })}>Continue to Site B →</a>
      </>
    )
  } else {
    body = (
      <>
        <span><strong>Both sites saved.</strong> The side-by-side comparison is ready.</span>
        <a className="sk-journey-cta" href="#compare">See comparison ↓</a>
      </>
    )
  }
  return (
    <div className={`sk-journey${done ? ' is-done' : ''}`} role="status">
      <ol className="sk-journey-steps" aria-label="Comparison progress">
        <li className={slot === 'A' && !done ? 'is-current' : 'is-done'}>A</li>
        <li className={slot === 'B' ? (done ? 'is-done' : 'is-current') : undefined}>B</li>
      </ol>
      {body}
    </div>
  )
}

/** A readable message for a failed request; long backend traces go behind "Technical detail". */
function explain(detail) {
  if (/SPICE/.test(detail)) {
    return { message: 'The ephemeris has no Sun and Earth positions for this date. Choose a start between 1850 and 2150.', raw: detail }
  }
  if (detail.length > 240) return { message: 'The backend reported an error.', raw: detail }
  return { message: detail, raw: null }
}

/** Which data is still on its way, for how long, and why the first visit is slower. */
function LoadingNote({ pending, since }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  const terrainPending = pending.includes('landscape') || pending.includes('shadows')
  let hint = 'Computing from SPICE ephemerides and LOLA elevation maps.'
  if (seconds >= 8) {
    hint = terrainPending
      ? 'A first visit to a site downloads LOLA elevation tiles and computes horizon maps. This can take one to two minutes; later visits are cached.'
      : 'Sunlight is computed for every point of the site at every step, so long windows at fine steps take longer.'
  }
  return (
    <div className="sk-loading" role="status" aria-live="polite">
      <span className="sk-spinner" aria-hidden="true" />
      <div>
        <strong>Loading {pending.map((label) => SECTION_LABEL[label]).join(', ')}… {seconds} s</strong>
        <span className="v2-muted v2-note">{hint}</span>
      </div>
    </div>
  )
}

/** Saved scenarios as chips; jump to the comparison. */
function ScenarioTray({ scenarios }) {
  const saved = ['A', 'B'].filter((slot) => scenarios[slot])
  if (!saved.length) return null
  return (
    <nav className="sk-tray" aria-label="Saved scenarios">
      {saved.map((slot) => (
        <a key={slot} className={`sk-chip sk-slot-${slot}`} href={siteUrl(scenarios[slot].site, scenarios[slot].time)}
          title={`Open Scenario ${slot}`}>
          <span className={`sk-slot-tag sk-slot-${slot}`}>{slot}</span>{siteLabel(scenarios[slot].site)}
        </a>
      ))}
      <a className="sk-chip" href="#compare">Compare</a>
    </nav>
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
      {mode === 'sun' && bodies && (
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

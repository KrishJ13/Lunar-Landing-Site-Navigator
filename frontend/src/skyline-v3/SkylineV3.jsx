import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react'
import { CALCULATIONS_URL } from '../lib/projectLinks.js'
import MissionDateFields from '../components/MissionDateFields.jsx'
import { missionRange, missionUrl, readMissionPlan } from '../lib/missionPlan.js'
import { SURROUND_KM, fetchIllumination, fetchShadowField, fetchSiteTerrain, fetchVisibilityWindows } from './api.js'
import FirstPersonTerrain from './FirstPersonTerrain.jsx'
import { DarkLegend } from './IlluminationPanel.jsx'
import { enuDirection, sunVisibleBesideEarth } from './lighting.js'

const SOLAR_CONSTANT = 1361 // W/m^2 at 1 AU (IAU 2015 Resolution B3 nominal total solar irradiance)
const AU_KM = 149_597_870.7
import OverheadTerrain from './OverheadTerrain.jsx'
import { bodiesAt, seenAt } from './sequence.js'
import SkyPanel from './SkyPanel.jsx'
import Timeline from './Timeline.jsx'
import ScenarioSaveActions from './ScenarioSaveActions.jsx'
import ScenarioComparison from './ScenarioComparison.jsx'
import useScenarios from '../lib/useScenarios.js'
import { assess, missionScenario, visibilitySeries } from './assessment.js'
import { EarthCommunications, MissionDetails, SelectedTimeDetails, VisibilityTracks } from './SiteOverview.jsx'
import { buildMissionSunlight } from './missionSunlight.js'

const VIEWS = [
  ['first-person', 'Landscape'],
  ['overhead', 'Orbital view'],
]
const SECTION_TIMEOUT_SECONDS = 60
const SLOTS = ['A', 'B']

const sameSite = (a, b) => a && b && a.lat === b.lat && a.lon === b.lon && a.diameterKm === b.diameterKm &&
  a.eyeHeightM === b.eyeHeightM
const sameSequence = (a, b) => sameSite(a, b) && a.timeUtc === b.timeUtc && a.hours === b.hours &&
  a.stepMinutes === b.stepMinutes && a.mastHeightM === b.mastHeightM

/**
 * Each site has its own mission range and playback state.
 *
 * Build loads the terrain (POST /api/site/terrain) and a time sequence
 * (POST /api/site/illumination: Sun, Earth and the fraction of the Sun each
 * point of the site sees, every step). A single timeline step drives the
 * first-person view (WebGL Sun, Earth and stars; sunlight and shadows), the
 * overhead view, the sky chart and the tables. Nothing is fetched while playing.
 */
export default function SkylineV3() {
  const [plan] = useState(() => readMissionPlan(window.location.search))
  const [firstSiteReady, setFirstSiteReady] = useState(false)
  const [activeScenarios, setActiveScenarios] = useState({})
  const savedScenarios = useScenarios()
  const siteDates = useRef(plan.siteDates)
  const comparing = plan.sites.length === 2
  const back = plan.sites.length ? missionUrl('moon.html', plan) : './moon.html'

  function updateLink(index, dates) {
    siteDates.current = siteDates.current.map((value, i) => i === index ? dates : value)
    const url = missionUrl('skyline-v3.html', { ...plan, siteDates: siteDates.current })
    window.history.replaceState(window.history.state, '', url)
  }

  return (
    <main className={`v2 sk v3-analysis-page${comparing ? ' v3-is-comparing' : ''}`}>
      <header className="v2-header sk-header">
        <a href={back} className="sk-back">← Moon Explorer</a>
        <div className="sk-title">
          <h1>{comparing ? 'Compare landing sites' : 'Lunar Skyline V3'}</h1>
        </div>
        <a href={CALCULATIONS_URL} target="_blank" rel="noreferrer">How we calculated things</a>
        {comparing && activeScenarios.A && activeScenarios.B && <a href="#compare">View comparison ↓</a>}
      </header>
      {plan.sites.length
        ? <div className="v3-analysis-grid">{plan.sites.map((site, index) =>
          <SiteAnalysis key={index} site={site} siteName={`Site ${SLOTS[index]}`} number={index + 1}
            settings={plan.settings} initialDates={plan.siteDates[index]} enabled={index === 0 || firstSiteReady}
            onFirstLoadSettled={index === 0 ? () => setFirstSiteReady(true) : undefined}
            savedScenarios={savedScenarios}
            onAssessment={(scenario) => setActiveScenarios((current) => ({ ...current, [SLOTS[index]]: scenario }))}
            onDatesApplied={(dates) => updateLink(index, dates)} />,
        )}</div>
        : <p className="v2-muted">Choose one or two landing sites in Moon Explorer to get started.</p>}
      {comparing && <ScenarioComparison scenarios={activeScenarios} />}
      <ScenarioComparison scenarios={savedScenarios} savedReport />
    </main>
  )
}

function SiteAnalysis({ site, siteName, number, settings, initialDates, enabled, onFirstLoadSettled, onDatesApplied,
  savedScenarios, onAssessment }) {
  const [dates, setDates] = useState(initialDates)
  const [inputs, setInputs] = useState(null)
  const [terrain, setTerrain] = useState(null)
  const [sequence, setSequence] = useState(null)
  const [field, setField] = useState(null)
  const [windows, setWindows] = useState(null)
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [errors, setErrors] = useState([])
  const [pending, setPending] = useState([])
  const [view, setView] = useState('first-person')
  const [lightMode, setLightMode] = useState('sun')
  const [overheadMode, setOverheadMode] = useState('shadows')
  const [advanced, setAdvanced] = useState(false)
  const inFlight = useRef(null)
  const firstPersonAim = useRef(null)
  const series = useMemo(() => sequence && terrain ? visibilitySeries(sequence, terrain) : null, [sequence, terrain])
  const scenario = useMemo(() => series ? missionScenario(inputs, assess(sequence, terrain, series)) : null,
    [inputs, sequence, terrain, series])
  const reportAssessment = useEffectEvent(() => onAssessment(scenario))
  useEffect(() => { reportAssessment() }, [scenario])
  const range = missionRange(dates, settings.stepMinutes)

  async function build(next) {
    const reuseSite = sameSite(next, inputs)
    const needsLandscape = !reuseSite || !terrain
    const reuseSequence = !needsLandscape && sameSequence(next, inputs) && sequence
    const reuseWindows = !needsLandscape && next.timeUtc === inputs.timeUtc && next.hours === inputs.hours && windows
    let landscape = needsLandscape ? null : terrain
    const sections = []
    if (needsLandscape) {
      sections.push(['landscape', (signal) => fetchSiteTerrain({
        lat: next.lat, lon: next.lon, diameterKm: next.diameterKm, observerHeightM: next.eyeHeightM,
      }, signal), (data) => { landscape = data; setTerrain(data) }])
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
        observerElevationM: landscape?.header.site.eye_m,
      }, signal), setSequence])
    }
    if (!reuseWindows) {
      sections.push(['visibility windows', (signal) => fetchVisibilityWindows(next, landscape, signal), setWindows])
    }
    if (!sections.length) return

    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setInputs(next)
    if (!reuseSite) {
      setTerrain(null)
      setField(null)
    }
    if (!reuseSequence) setSequence(null)
    if (!reuseWindows) setWindows(null)
    setStep(0)
    setPlaying(false)
    setErrors([])
    setPending(sections.map(([label]) => label))

    async function loadSection([label, load, receive]) {
      const timeout = AbortSignal.timeout(SECTION_TIMEOUT_SECONDS * 1000)
      const signal = AbortSignal.any([controller.signal, timeout])
      const start = performance.now()
      try {
        const data = await load(signal)
        signal.throwIfAborted()
        if (inFlight.current === controller) receive({ ...data, receivedMs: performance.now() - start })
      } catch (err) {
        if (inFlight.current === controller) {
          const detail = timeout.aborted ? `Timed out after ${SECTION_TIMEOUT_SECONDS} seconds.` : err.message
          setErrors((current) => [...current, `Could not load ${label}. ${detail}`])
        }
      } finally {
        if (inFlight.current === controller) setPending((current) => current.filter((item) => item !== label))
      }
    }
    // Both views use the landscape response. Give it priority over the lighting requests.
    if (needsLandscape) await loadSection(sections.shift())
    if (controller.signal.aborted) return
    await Promise.all(sections.map((section) => {
      if (section[0] !== 'visibility windows' || landscape) return loadSection(section)
      setPending((current) => current.filter((item) => item !== section[0]))
    }))
  }

  const initialize = useEffectEvent(async () => {
    const initialRange = missionRange(initialDates, settings.stepMinutes)
    if (!initialRange.error) await build({ ...site, ...settings, ...initialRange, siteName })
  })
  const finishInitialLoad = useEffectEvent(() => onFirstLoadSettled?.())
  useEffect(() => {
    if (!enabled) return
    let active = true
    // Skip the development StrictMode rehearsal before starting expensive requests.
    queueMicrotask(async () => {
      if (!active) return
      try {
        await initialize()
      } finally {
        if (active) finishInitialLoad()
      }
    })
    return () => {
      active = false
      const controller = inFlight.current
      inFlight.current = null
      controller?.abort()
    }
  }, [enabled])

  function applyDates(event) {
    event.preventDefault()
    if (range.error) return
    onDatesApplied(dates)
    void build({ ...site, ...settings, ...range, siteName })
  }

  const k = sequence ? Math.min(step, sequence.header.times.count - 1) : 0
  const frameSeconds = sequence ? sequence.header.times.step_minutes * 60 : 0
  const elapsed = k * frameSeconds
  const bodies = useMemo(() => (sequence ? bodiesAt(sequence, k) : null), [sequence, k])
  const frameKey = terrain && field && bodies ? inputs : null
  const missionLayers = useMemo(() => (sequence ? buildMissionSunlight(sequence) : null), [sequence])
  const missionLayer = missionLayers?.[overheadMode]
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
  const darkRuns = useMemo(() => (
    sequence && overheadMode === 'dark' ? darkRunLengths(sequence) : null
  ), [sequence, overheadMode])

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
    <section className="v3-analysis-site" data-site={number} aria-label={siteName}>
      <header className="v3-analysis-site-heading">
        <h2>{siteName}</h2>
        <p className="v2-muted">{site.lat.toFixed(4)}° lat, {site.lon.toFixed(4)}° lon east · {site.diameterKm} km across</p>
      </header>
      <form className="v2-form v3-mission-date-form sk-form" onSubmit={applyDates}>
        <MissionDateFields dates={dates} onChange={setDates} />
        <button type="submit" className="sk-primary" disabled={!enabled || !!range.error || pending.length > 0}>Update dates</button>
        {range.error && <p className="v2-error v2-wide" role="alert">{range.error}</p>}
      </form>
      {!enabled && <p className="v2-muted" role="status">Waiting for Site A to load.</p>}

      {pending.length > 0 && (
        <p className="v2-muted" role="status">
          Loading {pending[0] === 'landscape' ? 'landscape' : pending.join(', ')}…
        </p>
      )}
      {errors.map((error) => <p className="v2-error" role="alert" key={error}>{error}</p>)}

      {inputs && (terrain || sequence) && (
        <section className="v2-result">
          <MissionDetails inputs={inputs} terrain={terrain} windows={windows}
            loading={pending.includes('visibility windows')} />
          <SelectedTimeDetails inputs={inputs} bodies={bodies} windows={windows} elapsed={elapsed}
            loading={pending.includes('visibility windows')} />
          {windows && <EarthCommunications windows={windows} elapsed={elapsed} bodies={bodies} terrain={terrain}
            frameSeconds={frameSeconds} lastFrame={(sequence?.header.times.count ?? 0) - 1}
            onSelectFrame={(frame) => {
              setPlaying(false)
              setStep(frame)
              firstPersonAim.current?.(bodiesAt(sequence, frame).earth)
            }} />}
          {terrain && <div className="v2-tabs" role="tablist" aria-label="View">
            {VIEWS.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={view === key}
                className={view === key ? 'on' : undefined} onClick={() => setView(key)}>
                {label}
              </button>
            ))}
          </div>}
          {terrain && <div role="tabpanel">
            {view === 'first-person' ? (
              <>
                <FirstPersonTerrain key={`${inputs.lat},${inputs.lon},${inputs.eyeHeightM}`}
                  terrain={terrain} bodies={bodies} lighting={lighting} field={field} frameKey={frameKey}
                  waitingForFrame={pending.includes('shadows') || pending.includes('sunlight timeline')}
                  shadowHeightM={inputs.mastHeightM} aimRef={firstPersonAim} />
                {/* Legacy in-view elevation sources:
                <p className="v2-muted v2-note">
                  {terrain.header.elevation_maps?.length
                    ? `Elevation maps near to far · ${terrain.header.elevation_maps.join(' → ')}`
                    : 'LOLA LDEM_128 for the full view · 128 pixels per degree'}
                </p> */}
              </>
            ) : (
              <>
                <div className="v2-tabs v3-orbit-layers" role="group" aria-label="Orbital map layer">
                  <button type="button" aria-pressed={overheadMode === 'shadows'}
                    onClick={() => setOverheadMode('shadows')}>Shadows at selected time</button>
                  <button type="button" disabled={!frameKey} aria-pressed={overheadMode === 'intensity'}
                    onClick={() => setOverheadMode('intensity')}>Solar intensity at selected time</button>
                  {/* <button type="button" disabled={!missionLayers?.mission} aria-pressed={overheadMode === 'mission'}
                    onClick={() => setOverheadMode('mission')}>Mission sunlight</button> */}
                  <button type="button" disabled={!missionLayers?.energy} aria-pressed={overheadMode === 'energy'}
                    onClick={() => setOverheadMode('energy')}>Solar energy received</button>
                  <button type="button" disabled={!sequence} aria-pressed={overheadMode === 'dark'}
                    onClick={() => setOverheadMode('dark')}>Time in darkness</button>
                </div>
                <OverheadTerrain key={`${inputs.lat},${inputs.lon},${inputs.diameterKm}`} terrain={terrain}
                  frameKey={missionLayer ?? frameKey}
                  lighting={overheadMode === 'shadows' ? lighting : { mode: 'fixed' }}
                  overlay={missionLayer?.overlay ?? overlay}
                  field={missionLayer ? null : field} bodies={missionLayer ? null : bodies}
                  sunNow={field && !missionLayer ? sunNow : null} intensity={overheadMode === 'intensity' && !!field}
                  missionLayer={missionLayer}
                  shadowHeightM={inputs.mastHeightM} />
                {overheadMode === 'dark' && sequence && <DarkLegend
                  periodHours={(sequence.header.times.count - 1) * sequence.header.times.step_minutes / 60}
                  step={k} stepMinutes={sequence.header.times.step_minutes} />}
                <p className="v2-muted v2-note">
                  Amber outline · {terrain.header.site.diameter_km} km landing area
                  {' · '}{SURROUND_KM} km of surrounding terrain
                </p>
              </>
            )}
          </div>}
          {sequence && <Timeline result={sequence} step={k} onStep={setStep}
            playing={playing} setPlaying={setPlaying}
            tracks={windows && <VisibilityTracks windows={windows} elapsed={elapsed} />} />}
          {scenario && <ScenarioSaveActions scenario={scenario} scenarios={savedScenarios} />}
          {terrain && <details className="v3-advanced" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
            <summary>Advanced details</summary>
            {advanced && <>
              <LightingControl mode={lightMode} onChange={setLightMode} />
              {bodies && <SkyPanel bodies={bodies} terrain={terrain} />}
            </>}
          </details>}
        </section>
      )}
    </section>
  )
}

function LightingControl({ mode, onChange }) {
  const group = useId()
  return (
    <div className="v2-lighting">
      <fieldset>
        <legend>Lighting</legend>
        <label>
          <input type="radio" name={group} value="sun" checked={mode === 'sun'} onChange={() => onChange('sun')} />
          Sun at the timeline step
        </label>
        <label>
          <input type="radio" name={group} value="fixed" checked={mode === 'fixed'} onChange={() => onChange('fixed')} />
          Fixed light (terrain shape only)
        </label>
      </fieldset>
    </div>
  )
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

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  SELECTION_DIAMETER_KM, cameraFor, clamp, coordinates, isMapped, parseCoordinatePair,
  pickSurface, projectSurface, scaleBar, surfaceNormal, zoomLimit, zoomToward,
} from './geometry.js'
import { loadGlobe } from './globeShader.js'
import MissionDateFields from '../components/MissionDateFields.jsx'
import useScenarios from '../lib/useScenarios.js'
import { MAX_DIAMETER_KM, MIN_DIAMETER_KM, PLAYBACK_INTERVALS, isMissionTime,
  missionRange, missionUrl, readMissionPlan, saveMissionSettings } from '../lib/missionPlan.js'
import ProjectLinks from './ProjectLinks.jsx'
import './explorer.css'

const INITIAL_VIEW = { zoom: 1 }
const SITE_LABELS = ['A', 'B']

function coordinateText(normal) {
  const { lat, lon } = coordinates(normal)
  return `${lat.toFixed(5)}°, ${lon.toFixed(5)}°`
}

function useEphemeris(timestamp) {
  const [result, setResult] = useState(null)
  useEffect(() => {
    const controller = new AbortController()
    const query = new URLSearchParams({ timestamp_utc: timestamp })
    async function request() {
      try {
        const response = await fetch(`/api/v1/moon-globe?${query}`, { signal: controller.signal })
        const data = await response.json()
        if (!response.ok) throw new Error(data.detail || 'Lunar ephemeris unavailable.')
        if (!controller.signal.aborted) setResult({ timestamp, data })
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof SyntaxError ? 'Lunar ephemeris service unavailable.' : error.message
          setResult({ timestamp, error: message })
        }
      }
    }
    request()
    return () => controller.abort()
  }, [timestamp])
  return result?.timestamp === timestamp ? result : null
}

function MoonExplorer() {
  const [initial] = useState(() => readMissionPlan(window.location.search))
  const [dates, setDates] = useState(initial.dates)
  const [settings, setSettings] = useState(initial.settings)
  const savedScenarios = useScenarios()
  const [orbit, setOrbit] = useState(INITIAL_VIEW)
  const [renderer, setRenderer] = useState(null)
  const [error, setError] = useState('')
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hover, setHover] = useState(null)
  const [sites, setSites] = useState(() => [0, 1].map((index) => {
    const site = initial.sites[index]
    return site ? { point: surfaceNormal(site.lat, site.lon), diameterKm: site.diameterKm } : null
  }))
  const [activeSlot, setActiveSlot] = useState(0)
  const [selectionNotice, setSelectionNotice] = useState('')
  const [dragging, setDragging] = useState(false)
  const [showCoverage, setShowCoverage] = useState(false)
  const [plannerOpen, setPlannerOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [searchError, setSearchError] = useState('')
  const canvas = useRef(null)
  const drag = useRef(null)
  const redraw = useRef(null)

  const dateValid = isMissionTime(dates.start)
  const requestTime = `${dateValid ? dates.start : initial.dates.start}:00Z`
  const range = missionRange(dates, settings.stepMinutes)
  const response = useEphemeris(requestTime)
  const ephemeris = dateValid ? response?.data : null
  const camera = useMemo(() => ephemeris && cameraFor(ephemeris, orbit), [ephemeris, orbit])
  const hasSize = size.width > 0 && size.height > 0
  const maxZoom = camera && hasSize ? zoomLimit(size.width, size.height, camera) : 1
  const zoom = Math.min(maxZoom, orbit.zoom)
  const ready = Boolean(camera && renderer && hasSize && !error)
  const scale = camera && hasSize && scaleBar(size.width, size.height, zoom, camera)
  const mappedSites = useMemo(() => sites.map((site) =>
    site && camera && isMapped(site.point, camera.earth) ? site : null), [sites, camera])
  const pins = mappedSites.map((site) => ready && site && projectSurface(site.point, size.width, size.height, zoom, camera))
  const comparing = activeSlot === 1 || sites[1] !== null
  const siteCount = sites.filter(Boolean).length
  const pointerSurface = ready && hover && pickSurface(hover.x, hover.y, size.width, size.height, zoom, camera)

  useEffect(() => {
    const element = canvas.current
    const controller = new AbortController()
    let instance
    const resize = new ResizeObserver(() => {
      setSize({ width: element.clientWidth, height: element.clientHeight })
    })
    resize.observe(element)
    function contextLost(event) {
      event.preventDefault()
      setError('The graphics context was lost. Reload to reopen the globe.')
    }
    element.addEventListener('webglcontextlost', contextLost)
    loadGlobe(element, controller.signal, () => redraw.current?.()).then((loaded) => {
      if (controller.signal.aborted) {
        loaded.cleanup()
      } else {
        instance = loaded
        setRenderer(loaded)
      }
    }).catch((failure) => {
      if (!controller.signal.aborted) setError(failure.message)
    })
    return () => {
      controller.abort()
      resize.disconnect()
      element.removeEventListener('webglcontextlost', contextLost)
      instance?.cleanup()
    }
  }, [])

  const needsDetail = zoom > 1.2
  useEffect(() => {
    if (!renderer || !needsDetail) return
    renderer.improveDetail().then(() => redraw.current?.()).catch(() => {})
  }, [renderer, needsDetail])

  useEffect(() => {
    if (!ready || !size.width) return
    let frame = null
    redraw.current = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        renderer.draw(camera, ephemeris, zoom, showCoverage, mappedSites)
      })
    }
    redraw.current()
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      redraw.current = null
    }
  }, [ready, renderer, camera, ephemeris, zoom, size, showCoverage, mappedSites])

  function selectSite(point) {
    const samePoint = (site) => site && Math.hypot(...site.point.map((value, i) => value - point[i])) < 1e-6
    if (samePoint(sites[1 - activeSlot])) {
      setSelectionNotice('Choose a different location for the comparison.')
      return false
    }
    setSelectionNotice('')
    if (!samePoint(sites[activeSlot])) {
      setSites((previous) => previous.map((site, index) => index === activeSlot
        ? { point, diameterKm: site?.diameterKm ?? SELECTION_DIAMETER_KM }
        : site))
    }
    return true
  }

  function chooseSlot(slot) {
    setActiveSlot(slot)
    setSelectionNotice('')
  }

  function removeSite(slot) {
    setSites((previous) => [previous[1 - slot], null])
    chooseSlot(0)
  }

  function changeDiameter(slot, diameterKm) {
    setSites((previous) => previous.map((site, index) => index === slot
      ? { ...site, diameterKm }
      : site))
  }

  function updateSetting(key, value) {
    const next = { ...settings, [key]: value }
    setSettings(next)
    saveMissionSettings(next)
  }

  function openAnalysis(event) {
    event.preventDefault()
    if (!siteCount || range.error) return
    const locations = sites.filter(Boolean).map(({ point, diameterKm }) => ({ ...coordinates(point), diameterKm }))
    const plan = { sites: locations, dates, settings }
    window.history.replaceState(window.history.state, '', missionUrl('moon.html', plan))
    window.location.assign(missionUrl('skyline-v3.html', plan))
  }

  function rotate(deltaLongitude, deltaLatitude) {
    setOrbit((previous) => {
      const center = coordinates(cameraFor(ephemeris, previous).normal)
      const longitude = ((center.lon + deltaLongitude + 540) % 360) - 180
      const latitude = clamp(center.lat + deltaLatitude, -90, 90)
      if (!isMapped(surfaceNormal(latitude, longitude), camera.earth)) return previous
      return { zoom, latitude, longitude }
    })
  }

  function changeZoom(factor) {
    setOrbit((previous) => ({ ...previous, zoom: clamp(Math.min(previous.zoom, maxZoom) * factor, 1, maxZoom) }))
  }

  function findCoordinates(event) {
    event.preventDefault()
    if (!ready) return
    const target = parseCoordinatePair(query)
    if (!target) {
      setSearchError('Enter a latitude from −90 to 90 and a longitude from −180 to 180.')
      return
    }
    const point = surfaceNormal(target.latitude, target.longitude)
    if (!isMapped(point, camera.earth)) {
      setSearchError('That location is outside the clickable area. Try the Earth-facing side or either pole.')
      return
    }
    if (selectSite(point)) setOrbit({ ...target, zoom })
    setHover(null)
    setSearchError('')
  }

  function pointerPosition(event) {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  function startDrag(event) {
    if (!ready || event.button !== 0 || !event.isPrimary) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const position = pointerPosition(event)
    drag.current = { ...position, start: position, id: event.pointerId, moved: false }
    setHover(null)
  }

  function movePointer(event) {
    if (!ready || !event.isPrimary) return
    const position = pointerPosition(event)
    const active = drag.current
    if (!active) {
      if (event.pointerType === 'mouse') setHover(position)
      return
    }
    if (active.id !== event.pointerId) return
    if (!active.moved && Math.hypot(position.x - active.start.x, position.y - active.start.y) < 5) return
    if (!active.moved) setDragging(true)
    const speed = 0.32 / zoom
    const longitudeScale = Math.max(0.025, Math.hypot(camera.normal[0], camera.normal[1]))
    rotate(-(position.x - active.x) * speed / longitudeScale, (position.y - active.y) * speed)
    Object.assign(active, position, { moved: true })
  }

  function endDrag(event) {
    const active = drag.current
    if (!active || active.id !== event.pointerId) return
    const position = pointerPosition(event)
    drag.current = null
    setDragging(false)
    if (event.type !== 'pointerup' || !ready) return
    if (!active.moved && Math.hypot(position.x - active.start.x, position.y - active.start.y) < 5) {
      const surface = pickSurface(position.x, position.y, size.width, size.height, zoom, camera)
      if (surface) selectSite(surface)
    }
    if (event.pointerType === 'mouse') setHover(position)
  }

  useEffect(() => {
    const element = canvas.current
    function wheel(event) {
      if (!ready) return
      event.preventDefault()
      const step = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      const factor = Math.exp(-clamp(step, -180, 180) * 0.0025)
      const rect = element.getBoundingClientRect()
      const point = pickSurface(
        event.clientX - rect.left, event.clientY - rect.top, size.width, size.height, zoom, camera,
      )
      setOrbit((previous) => {
        const currentZoom = Math.min(maxZoom, previous.zoom)
        const nextZoom = clamp(currentZoom * factor, 1, maxZoom)
        return zoomToward({ ...previous, zoom: currentZoom }, camera, point, nextZoom)
      })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [ready, maxZoom, zoom, size, camera])

  function handleKey(event) {
    if (!ready) return
    const tilt = 5 / zoom
    switch (event.key) {
      case 'ArrowLeft': rotate(-tilt, 0); break
      case 'ArrowRight': rotate(tilt, 0); break
      case 'ArrowUp': rotate(0, tilt); break
      case 'ArrowDown': rotate(0, -tilt); break
      case '+':
      case '=': changeZoom(1.3); break
      case '-': changeZoom(1 / 1.3); break
      case 'Home': setOrbit(INITIAL_VIEW); break
      case 'Enter': {
        const surface = pickSurface(size.width / 2, size.height / 2, size.width, size.height, zoom, camera)
        if (surface) selectSite(surface)
        break
      }
      case 'Escape': removeSite(activeSlot); break
      default: return
    }
    event.preventDefault()
  }

  const status = error || (!dateValid && 'Choose a date between December 1849 and January 2150.')
    || response?.error || (!ready && 'Loading Moon…')

  return (
    <main className="moon-shell">
      <header className="moon-header">
        <div className="moon-brand">
          <span className="moon-brand-mark" aria-hidden="true" />
          <div>
            <h1>Lunar Landing Site Navigator</h1>
            <p>Moon Explorer · Choose a mission window and one or two landing sites.</p>
          </div>
        </div>
        <ProjectLinks />
      </header>
      <section className="moon-stage moon-map-workspace" aria-label="Interactive lunar globe">
        <p className="sr-only" id="moon-instructions">Drag to tilt. Scroll over a feature to zoom towards it, or use + and − to zoom at the centre. Select a mapped point to set a site. With the globe focused, use the arrow keys to tilt and Enter to select its centre.</p>
        <div className="moon-globe">
          <canvas ref={canvas} tabIndex={0} aria-label="Moon surface" aria-describedby="moon-instructions"
            className={`moon-canvas${dragging ? ' is-dragging' : ''}${ready ? '' : ' is-loading'}`}
            onPointerDown={startDrag} onPointerMove={movePointer} onPointerUp={endDrag}
            onLostPointerCapture={endDrag} onPointerCancel={endDrag} onPointerLeave={() => setHover(null)}
            onKeyDown={handleKey} />
          {status && <div className="moon-status" role="status">{status}</div>}
          {pins.map((pin, index) => pin && (
            <span key={index} className="moon-pin" data-site={index + 1} aria-hidden="true"
              style={{ left: pin.x, top: pin.y }}>{SITE_LABELS[index]}</span>
          ))}
          <div className="moon-scale" aria-label={scale ? `Map centre scale: ${scale.distance} kilometres` : 'Map scale unavailable'}>
            <span>{scale ? `${scale.distance} km` : '— km'}</span>
            <span className="moon-scale-line" style={{ width: scale?.pixels ?? 0 }} aria-hidden="true" />
          </div>
          {pointerSurface && (
            <output className="moon-hover" style={{
              left: Math.max(8, Math.min(hover.x + 14, size.width - 205)),
              top: Math.max(8, Math.min(hover.y + 14, size.height - 41)),
            }}>{coordinateText(pointerSurface)}</output>
          )}
          <div className="moon-toolbar" role="group" aria-label="Globe view">
            <button type="button" disabled={!ready} onClick={() => setOrbit(INITIAL_VIEW)}>Reset view</button>
            <button type="button" disabled={!ready}
              onClick={() => setOrbit({ longitude: 0, latitude: 88.5, zoom: 2 })}>North pole</button>
            <button type="button" disabled={!ready}
              onClick={() => setOrbit({ longitude: 0, latitude: -88.5, zoom: 2 })}>South pole</button>
            <span className="moon-toolbar-sep" aria-hidden="true" />
            <button type="button" disabled={!ready || zoom >= maxZoom} onClick={() => changeZoom(1.35)}
              aria-label="Zoom in">+</button>
            <button type="button" disabled={!ready || zoom <= 1} onClick={() => changeZoom(1 / 1.35)}
              aria-label="Zoom out">−</button>
          </div>
          <div className="moon-stage-actions">
            <label className="moon-coverage-toggle">
              <input type="checkbox" checked={showCoverage}
                onChange={(event) => setShowCoverage(event.target.checked)} />
              Show clickable area
            </label>
            {showCoverage && <p className="moon-coverage-note">
              Click anywhere in the highlighted area. Terrain outside it is shown for context and is unavailable for site calculations.
            </p>}
          </div>
        </div>
        <aside className="moon-planner" aria-label="Mission planner">
          <button type="button" className="moon-planner-toggle" aria-expanded={plannerOpen}
            aria-controls="moon-planner-content" onClick={() => setPlannerOpen((open) => !open)}>
            Mission planner <span aria-hidden="true">{plannerOpen ? '−' : '+'}</span>
          </button>
          <div id="moon-planner-content" className="moon-planner-content" hidden={!plannerOpen}>
            <div className="moon-planner-fields">
              <form className="moon-coordinate-form planner-search" onSubmit={findCoordinates}>
                <label htmlFor="moon-coordinates">Landing site coordinates</label>
                <div>
                  <input id="moon-coordinates" type="search" placeholder="Latitude, longitude"
                    value={query} onChange={(event) => {
                      setQuery(event.target.value)
                      setSearchError('')
                    }} aria-invalid={Boolean(searchError)}
                    aria-describedby={searchError ? 'moon-coordinate-error' : undefined} />
                  <button type="submit" disabled={!ready}>Set Site {SITE_LABELS[activeSlot]}</button>
                </div>
                {searchError && <p id="moon-coordinate-error" role="alert">{searchError}</p>}
              </form>
              <section className="planner-block">
                <h2><span className="planner-num">1</span>Mission dates</h2>
                <form id="mission-plan" className="moon-mission-form planner-when" onSubmit={openAnalysis}>
                  <MissionDateFields dates={dates} onChange={setDates} />
                  {range.error && <p className="moon-form-error" role="alert">{range.error}</p>}
                </form>
              </section>
              <section className="planner-block">
                <h2><span className="planner-num">2</span>Landing sites</h2>
                <div className="moon-site-picker-buttons" role="group" aria-label="Site selection">
                  {SITE_LABELS.slice(0, comparing ? 2 : 1).map((label, index) => (
                    <button key={label} type="button" className="moon-site-choice" data-site={index + 1}
                      aria-pressed={activeSlot === index} onClick={() => chooseSlot(index)}>
                      <span className="moon-site-dot" aria-hidden="true" />Site {label}
                    </button>
                  ))}
                  {!comparing && sites[0] && (
                    <button type="button" className="planner-secondary" onClick={() => chooseSlot(1)}>Add site to compare</button>
                  )}
                  {comparing && !sites[1] && (
                    <button type="button" onClick={() => chooseSlot(0)}>Cancel comparison</button>
                  )}
                </div>
                {sites.map((site, index) => site && (
                  <SiteCard key={index} site={site} number={index + 1}
                    onRemove={() => removeSite(index)}
                    onDiameter={(value) => changeDiameter(index, value)}
                    onLocate={ready && mappedSites[index] ? () => {
                      const { lat, lon } = coordinates(site.point)
                      setOrbit({ latitude: lat, longitude: lon, zoom })
                    } : null} />
                ))}
                <p className="planner-hint" role="status">
                  {selectionNotice || (sites[activeSlot]
                    ? `Click the Moon or enter coordinates to move Site ${SITE_LABELS[activeSlot]}.`
                    : `Click the Moon or enter coordinates to set Site ${SITE_LABELS[activeSlot]}.`)}
                </p>
              </section>
              <details className="moon-settings">
                <summary>Settings</summary>
                <label>Playback interval
                  <select value={settings.stepMinutes} onChange={(event) => updateSetting('stepMinutes', Number(event.target.value))}>
                    {PLAYBACK_INTERVALS.map((value) => <option value={value} key={value}>
                      {value < 60 ? `${value} min` : `${value / 60} h`}
                    </option>)}
                  </select>
                </label>
                <label>Shadow height above ground <strong>{settings.mastHeightM} m</strong>
                  <input type="range" min={0} max={50} step={0.5} value={settings.mastHeightM}
                    onChange={(event) => updateSetting('mastHeightM', event.currentTarget.valueAsNumber)} />
                </label>
                <label>Observer height above ground <strong>{settings.eyeHeightM} m</strong>
                  <input type="range" min={0} max={100} step={0.1} value={settings.eyeHeightM}
                    onChange={(event) => updateSetting('eyeHeightM', event.currentTarget.valueAsNumber)} />
                </label>
              </details>
              <a className="moon-credit" href="https://trek.nasa.gov/moon/" target="_blank" rel="noreferrer">
                NASA Moon Trek · LROC / LOLA
              </a>
            </div>
            <div className="planner-actions">
              <button type="submit" form="mission-plan" className="moon-open" disabled={!siteCount || !!range.error}>
                {siteCount === 2 ? 'Compare' : 'Explore'} <span aria-hidden="true">→</span>
              </button>
              {(savedScenarios.A || savedScenarios.B) && <a className="planner-link" href="./skyline-v3.html#saved-scenarios">
                View saved scenarios →
              </a>}
            </div>
          </div>
        </aside>
      </section>
    </main>
  )
}

function SiteCard({ site, number, onRemove, onDiameter, onLocate }) {
  const title = `moon-site-${number}-title`
  const label = SITE_LABELS[number - 1]
  return (
    <article className={`planner-site planner-site-${label}`} data-site={number} aria-labelledby={title}>
      <header className="moon-card-heading">
        <div>
          <h3 id={title}><span className={`moon-slot-tag moon-slot-${label}`} aria-hidden="true">{label}</span>Site {label}</h3>
          <p>{coordinateText(site.point)}</p>
        </div>
        <button type="button" className="moon-card-close" aria-label={`Remove Site ${label}`} onClick={onRemove}>×</button>
      </header>
      <label className="moon-selection-diameter">
        <span>Diameter <strong>{site.diameterKm} km</strong></span>
        <input type="range" min={MIN_DIAMETER_KM} max={MAX_DIAMETER_KM} step={1}
          value={site.diameterKm} onChange={(event) => onDiameter(event.currentTarget.valueAsNumber)}
          aria-label={`Site ${label} diameter`} aria-valuetext={`${site.diameterKm} km`} />
      </label>
      <div className="moon-card-actions">
        <button type="button" disabled={!onLocate} onClick={onLocate}>Center on site</button>
      </div>
    </article>
  )
}

export default MoonExplorer

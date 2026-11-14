import { useEffect, useMemo, useRef, useState } from 'react'
import {
  SELECTION_DIAMETER_KM, cameraFor, clamp, coordinates, isMapped, parseCoordinatePair,
  pickSurface, projectSurface, scaleBar, surfaceNormal, zoomLimit, zoomToward,
} from './geometry.js'
import { loadGlobe } from './globeShader.js'
import './explorer.css'

const INITIAL_VIEW = { zoom: 1 }
const TIMES = Array.from({ length: 96 }, (_, index) =>
  `${String(Math.floor(index / 4)).padStart(2, '0')}:${String(index % 4 * 15).padStart(2, '0')}`,
)
const MIN_DATE = '1849-12-27'
const MAX_DATE = '2150-01-21'

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
  const [initial] = useState(() => new Date(Math.floor(Date.now() / 900000) * 900000).toISOString())
  const [date, setDate] = useState(initial.slice(0, 10))
  const [time, setTime] = useState(initial.slice(11, 16))
  const [orbit, setOrbit] = useState(INITIAL_VIEW)
  const [renderer, setRenderer] = useState(null)
  const [error, setError] = useState('')
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hover, setHover] = useState(null)
  const [selected, setSelected] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [showCoverage, setShowCoverage] = useState(false)
  const [query, setQuery] = useState('')
  const [searchError, setSearchError] = useState('')
  const canvas = useRef(null)
  const drag = useRef(null)
  const redraw = useRef(null)

  const dateValid = Boolean(date && date >= MIN_DATE && date <= MAX_DATE)
  const requestTime = `${dateValid ? date : initial.slice(0, 10)}T${time}:00Z`
  const response = useEphemeris(requestTime)
  const ephemeris = dateValid ? response?.data : null
  const camera = useMemo(() => ephemeris && cameraFor(ephemeris, orbit), [ephemeris, orbit])
  const hasSize = size.width > 0 && size.height > 0
  const maxZoom = camera && hasSize ? zoomLimit(size.width, size.height, camera) : 1
  const zoom = Math.min(maxZoom, orbit.zoom)
  const ready = Boolean(camera && renderer && !error)
  const scale = camera && hasSize && scaleBar(size.width, size.height, zoom, camera)
  const activeSelection = camera && selected && isMapped(selected, camera.earth) ? selected : null
  const pin = ready && activeSelection && projectSurface(activeSelection, size.width, size.height, zoom, camera)
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
        renderer.draw(camera, ephemeris, zoom, showCoverage, activeSelection)
      })
    }
    redraw.current()
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      redraw.current = null
    }
  }, [ready, renderer, camera, ephemeris, zoom, size, showCoverage, activeSelection])

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
    setOrbit({ ...target, zoom })
    setSelected(point)
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
      if (surface) setSelected(surface)
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
        if (surface) setSelected(surface)
        break
      }
      case 'Escape': setSelected(null); break
      default: return
    }
    event.preventDefault()
  }

  const status = error || (!dateValid && 'Choose a date between December 1849 and January 2150.')
    || response?.error || (!ready && 'Loading Moon…')

  return (
    <main className="moon-shell">
      <header className="moon-header">
        <a className="moon-back" href="./">← Menu</a>
        <div>
          <h1>Moon Explorer</h1>
          <p>Earth-facing side of the Moon</p>
        </div>
      </header>
      <div className="moon-workspace">
        <aside className="moon-controls">
          <h2>Observation time</h2>
          <label>
            Date (UTC)
            <input type="date" value={date} min={MIN_DATE} max={MAX_DATE}
              onInput={(event) => setDate(event.currentTarget.value)}
              onChange={(event) => setDate(event.currentTarget.value)} />
          </label>
          <label>
            Time (UTC)
            <select value={time} onChange={(event) => setTime(event.target.value)}>
              {TIMES.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
          <div className="moon-phase">
            <span>Earth-facing illumination</span>
            <strong>{ephemeris ? `${(ephemeris.illuminated_fraction * 100).toFixed(1)}%` : '—'}</strong>
          </div>
          <div className="moon-view-actions">
            <button type="button" disabled={!ready} onClick={() => setOrbit(INITIAL_VIEW)}>Reset view</button>
            <div className="moon-poles">
              <button type="button" disabled={!ready}
                onClick={() => setOrbit({ longitude: 0, latitude: 88.5, zoom: 2 })}>North pole</button>
              <button type="button" disabled={!ready}
                onClick={() => setOrbit({ longitude: 0, latitude: -88.5, zoom: 2 })}>South pole</button>
            </div>
          </div>
          <p id="moon-instructions">Drag to tilt. Scroll over a feature to zoom towards it, or use + and − to zoom at the centre. Select a mapped point for its coordinates. With the globe focused, use the arrow keys to tilt and Enter to select its centre.</p>
          <a className="moon-credit" href="https://trek.nasa.gov/moon/" target="_blank" rel="noreferrer">
            NASA Moon Trek · LROC / LOLA
          </a>
        </aside>
        <section className="moon-stage" aria-label="Interactive lunar globe">
          <canvas ref={canvas} tabIndex={0} aria-label="Moon surface" aria-describedby="moon-instructions"
            className={`moon-canvas${dragging ? ' is-dragging' : ''}${ready ? '' : ' is-loading'}`}
            onPointerDown={startDrag} onPointerMove={movePointer} onPointerUp={endDrag}
            onLostPointerCapture={endDrag} onPointerCancel={endDrag} onPointerLeave={() => setHover(null)}
            onKeyDown={handleKey} />
          {status && <div className="moon-status" role="status">{status}</div>}
          {pin && <span className="moon-pin" aria-hidden="true" style={{ left: pin.x, top: pin.y }} />}
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
          <div className="moon-stage-top">
            <form className="moon-coordinate-search" onSubmit={findCoordinates}>
              <label htmlFor="moon-coordinates">Search latitude, longitude</label>
              <div>
                <input id="moon-coordinates" type="search" placeholder="-89.5, -137"
                  value={query} onChange={(event) => {
                    setQuery(event.target.value)
                    setSearchError('')
                  }} aria-invalid={Boolean(searchError)}
                  aria-describedby={searchError ? 'moon-search-error' : undefined} />
                <button type="submit" disabled={!ready}>Go</button>
              </div>
              {searchError && <p id="moon-search-error" role="alert">{searchError}</p>}
            </form>
            {selected && (
              <div className="moon-selection" aria-label="Selected lunar coordinates">
                <span>{coordinateText(selected)}<small>{SELECTION_DIAMETER_KM} km diameter</small></span>
                <button type="button" aria-label="Clear selected point" onClick={() => setSelected(null)}>×</button>
              </div>
            )}
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
            <div className="moon-zoom" role="group" aria-label="Zoom controls">
              <button type="button" disabled={!ready || zoom >= maxZoom} onClick={() => changeZoom(1.35)}
                aria-label="Zoom in">+</button>
              <button type="button" disabled={!ready || zoom <= 1} onClick={() => changeZoom(1 / 1.35)}
                aria-label="Zoom out">−</button>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}

export default MoonExplorer

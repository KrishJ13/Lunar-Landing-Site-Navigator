import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import CompassStrip from '../components/CompassStrip.jsx'
import { angleDiff, compassName, elevationStep, makeViewScale, wrap360 } from '../lib/view.js'
import { BODY_STYLE, skylineAt, visibleFraction, visibilityNote } from './bodies.js'
import { sizeCanvas, useWidth } from './useCanvasSize.js'
import { createPanoramaRenderer } from './panoramaRenderer.js'
import { createSkyRenderer } from '../lib/skyShader.js'

const FOV_OPTIONS = [5, 10, 20, 60, 90, 120, 180]
const INITIAL_HEADING = 180
const MIN_VISIBLE_ELEVATION = -30
const MAX_PITCH = 85
const EYE_LEVEL = 'rgba(255, 212, 59, 0.8)'

const clampPitch = (pitch, minPitch) => Math.max(minPitch, Math.min(MAX_PITCH, pitch))

/**
 * First-person 360° shaded terrain from the eye, at true proportions (1° up is as
 * large as 1° across). Drag or use the arrow keys to look around.
 * Behind the terrain, a WebGL sky (lib/skyShader.js, as the original Lunar
 * Skyline): stars, the Sun and the Earth at their true angular size, the Earth
 * with its phase. `bodies` are the SPICE positions at the timeline step; the
 * terrain hides them where the skyline is above them. `field` holds the height
 * grids for GPU shadows: with the real Sun, every visible ground point gets the
 * fraction of the Sun's disc it sees (shadowField.js), baked once per time step.
 */
export default function FirstPersonTerrain({ terrain, bodies = null, lighting = { mode: 'fixed' }, field = null, shadowHeightM = 0.5, frameKey,
  height = 440 }) {
  const wrapRef = useRef(null)
  const skyRef = useRef(null)
  const skyRendererRef = useRef(null)
  const glRef = useRef(null)
  const overlayRef = useRef(null)
  const measuredWidth = useWidth(wrapRef)
  const width = measuredWidth ?? 800
  const [heading, setHeading] = useState(INITIAL_HEADING)
  const [pitch, setPitch] = useState(() => {
    const index = Math.round(INITIAL_HEADING / terrain.header.skyline.azimuth_step_deg)
    return Math.max(0, terrain.arrays.ray_skyline_deg[index] - 8)
  })
  const [fov, setFov] = useState(90)
  const viewHeight = Math.min(height, Math.floor(width * (90 - MIN_VISIBLE_ELEVATION) / fov))
  // The lower edge sits half a vertical field of view below the camera centre.
  const minPitch = MIN_VISIBLE_ELEVATION + fov * viewHeight / (2 * width)
  const viewPitch = clampPitch(pitch, minPitch)
  const drag = useRef(null)
  const rendererRef = useRef(null)
  const [error, setError] = useState(null)
  const [drawnFrame, setDrawnFrame] = useState(null)
  const reveal = frameKey !== null && drawnFrame === frameKey && !error

  useEffect(() => {
    const canvas = glRef.current
    let renderer
    let active = true
    try {
      renderer = createPanoramaRenderer(canvas, terrain)
      rendererRef.current = renderer
    } catch (error) {
      queueMicrotask(() => { if (active) setError(error.message) })
    }
    return () => {
      active = false
      renderer?.dispose()
      rendererRef.current = null
    }
  }, [terrain])

  useEffect(() => {
    const sky = createSkyRenderer(skyRef.current)
    skyRendererRef.current = sky
    return () => {
      sky?.dispose()
      skyRendererRef.current = null
    }
  }, [])

  useEffect(() => {
    rendererRef.current?.setField(field, shadowHeightM)
  }, [terrain, field, shadowHeightM])

  useEffect(() => {
    const sun = lighting.mode === 'sun' ? { dir: lighting.sun, radius: lighting.sunRadius } : null
    rendererRef.current?.setSun(sun)
  }, [terrain, field, shadowHeightM, lighting])

  const visibility = useMemo(
    () => (bodies ? { sun: visibleFraction(bodies.sun, terrain), earth: visibleFraction(bodies.earth, terrain) } : null),
    [bodies, terrain],
  )

  const scale = useMemo(
    () => makeViewScale({ width, height: viewHeight, heading, pitch: viewPitch, fov, exaggeration: 1 }),
    [width, viewHeight, heading, viewPitch, fov],
  )

  useEffect(() => {
    if (!frameKey || measuredWidth === null || error) return
    const frame = requestAnimationFrame(() => {
      const renderer = rendererRef.current
      if (!renderer) return
      try {
        const dpr = sizeCanvas(glRef.current, width, viewHeight)
        sizeCanvas(skyRef.current, width, viewHeight)
        sizeCanvas(overlayRef.current, width, viewHeight)
        skyRendererRef.current?.render({ heading, pitch: viewPitch, pxPerDeg: width / fov, dpr, bodies, visibility })
        renderer.draw({ heading, pitch: viewPitch, fov, width, height: viewHeight, lighting })
        drawOverlay(overlayRef.current.getContext('2d'), scale, dpr, terrain, bodies, visibility, !skyRendererRef.current)
        // Reveal during the drawing callback, before the browser presents the frame.
        if (drawnFrame !== frameKey) flushSync(() => setDrawnFrame(frameKey))
      } catch (err) {
        setError(err.message)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [frameKey, drawnFrame, measuredWidth, error, scale, heading, viewPitch, fov, width, viewHeight,
    terrain, bodies, visibility, lighting, field])

  const tilt = (deg) => setPitch((p) => clampPitch(clampPitch(p, minPitch) + deg, minPitch))

  function onPointerDown(e) {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, heading, pitch: viewPitch }
  }
  function onPointerMove(e) {
    const d = drag.current
    if (!d) return
    const pxPerDeg = width / fov
    setHeading(wrap360(d.heading - (e.clientX - d.x) / pxPerDeg))
    setPitch(clampPitch(d.pitch + (e.clientY - d.y) / pxPerDeg, minPitch))
  }
  function onKeyDown(e) {
    const step = e.shiftKey ? 1 : 5
    const keys = {
      ArrowLeft: () => setHeading((h) => wrap360(h - step)),
      ArrowRight: () => setHeading((h) => wrap360(h + step)),
      ArrowUp: () => tilt(step / 2),
      ArrowDown: () => tilt(-step / 2),
    }
    if (keys[e.key]) {
      e.preventDefault()
      keys[e.key]()
    }
  }

  return (
    <div className="v2-fp">
      <div className="v2-canvas-wrap" ref={wrapRef} style={{ visibility: reveal ? 'visible' : 'hidden' }}
        tabIndex={0} onKeyDown={onKeyDown}>
        <CompassStrip heading={heading} fov={fov} />
        <div className="v2-stack" style={{ height: viewHeight }}>
          <canvas ref={skyRef} className="v2-sky-canvas" style={{ width, height: viewHeight }} aria-hidden="true" />
          <canvas
            ref={glRef}
            className="v2-gl draggable"
            style={{ width, height: viewHeight }}
            role="img"
            aria-label={`Shaded terrain facing ${Math.round(heading)}° (${compassName(heading)}), pitch ${viewPitch.toFixed(1)}°`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => { drag.current = null }}
            onPointerCancel={() => { drag.current = null }}
          />
          <canvas ref={overlayRef} className="v2-overlay" style={{ width, height: viewHeight }} aria-hidden="true" />
        </div>
      </div>
      {error && <p className="v2-error">{error}</p>}
      <div className="v2-controls">
        <label>
          Heading {Math.round(heading)}°
          <input type="range" min={0} max={359} value={Math.round(heading) % 360}
            onChange={(e) => setHeading(Number(e.target.value))} />
        </label>
        <label>
          Field of view{' '}
          <select value={fov} onChange={(e) => setFov(Number(e.target.value))}>
            {FOV_OPTIONS.map((f) => <option key={f} value={f}>{f}°</option>)}
          </select>
        </label>
        <button type="button" onClick={() => setPitch(clampPitch(0, minPitch))}>
          {minPitch > 0 ? 'Reset tilt' : 'Level view'}
        </button>
        {bodies && Object.entries(BODY_STYLE).map(([key, { label }]) => (
          <button key={key} type="button" className={`sk-find sk-tone-${key}`} onClick={() => {
            setHeading(wrap360(bodies[key].azimuth_deg))
            setPitch(clampPitch(bodies[key].elevation_deg, minPitch))
          }}>
            Find {label}
          </button>
        ))}
        <span className="v2-muted">Pitch {viewPitch.toFixed(1)}° · drag or arrow keys (Shift = 1°)</span>
      </div>
    </div>
  )
}

/** Elevation labels, eye-level line, and the Sun and Earth labels. */
function drawOverlay(ctx, scale, dpr, terrain, bodies, visibility, drawDiscs) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, scale.width, scale.height)
  ctx.font = '11px system-ui, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  const step = elevationStep(scale.height / scale.pxPerDegY)
  for (let el = Math.ceil(scale.elAt(scale.height) / step) * step; el <= scale.elAt(0); el += step) {
    ctx.fillText(`${+el.toFixed(2)}°`, 4, scale.y(el) - 3)
  }
  const yEye = Math.round(scale.y(0)) + 0.5
  if (yEye > 0 && yEye < scale.height) {
    ctx.setLineDash([6, 4])
    ctx.strokeStyle = EYE_LEVEL
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, yEye)
    ctx.lineTo(scale.width, yEye)
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (bodies) drawBodies(ctx, scale, terrain, bodies, visibility, drawDiscs)
}

/**
 * Labels for the Sun and Earth, and a dashed outline where a body is behind the
 * terrain. The discs themselves come from the sky shader; without WebGL2
 * (drawDiscs) they are drawn here as flat circles, clipped to the sky.
 */
function drawBodies(ctx, scale, terrain, bodies, visibility, drawDiscs) {
  const { width, height } = scale
  ctx.font = '12px system-ui, sans-serif'
  ctx.textAlign = 'center'
  for (const [key, { label, colour }] of Object.entries(BODY_STYLE)) {
    const b = bodies[key]
    // Exact angular size: radius = angular radius (deg) x pixels per degree, no minimum.
    const r = b.angular_radius_deg * scale.pxPerDegY
    const x = width / 2 + angleDiff(b.azimuth_deg, scale.heading) * scale.pxPerDegX
    const y = scale.y(b.elevation_deg)
    if (x < -r - 80 || x > width + r + 80 || y < -r - 20 || y > height + r + 20) continue
    const fraction = visibility?.[key] ?? visibleFraction(b, terrain)

    if (drawDiscs) {
      const sky = new Path2D()
      sky.moveTo(0, -1)
      for (let px = 0; px <= width; px++) sky.lineTo(px, scale.y(skylineAt(terrain, scale.azAt(px))))
      sky.lineTo(width, -1)
      sky.closePath()
      ctx.save()
      ctx.clip(sky)
      ctx.beginPath()
      ctx.arc(x, y, r, 0, 2 * Math.PI)
      ctx.fillStyle = colour
      ctx.fill()
      ctx.restore()
    }
    if (fraction < 0.999) {
      ctx.beginPath()
      ctx.arc(x, y, Math.max(r, 2), 0, 2 * Math.PI)
      ctx.setLineDash([3, 2])
      ctx.lineWidth = 1.2
      ctx.strokeStyle = colour
      ctx.stroke()
      ctx.setLineDash([])
    }

    const note = visibilityNote(b, fraction)
    const text = note ? `${label} (${note})` : label
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'
    ctx.fillStyle = '#fff'
    ctx.strokeText(text, x, y - r - 6)
    ctx.fillText(text, x, y - r - 6)
  }
}

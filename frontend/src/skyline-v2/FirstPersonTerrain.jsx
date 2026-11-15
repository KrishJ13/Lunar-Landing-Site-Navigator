import { useEffect, useMemo, useRef, useState } from 'react'
import CompassStrip from '../components/CompassStrip.jsx'
import { compassName, elevationStep, makeViewScale, wrap360 } from '../lib/view.js'
import { sizeCanvas, useWidth } from './useCanvasSize.js'
import { createPanoramaRenderer } from './panoramaRenderer.js'

const FOV_OPTIONS = [5, 10, 20, 60, 90, 120, 180]
const INITIAL_HEADING = 180
const MIN_VISIBLE_ELEVATION = -30
const MAX_PITCH = 85
const EYE_LEVEL = 'rgba(255, 212, 59, 0.8)'

const clampPitch = (pitch, minPitch) => Math.max(minPitch, Math.min(MAX_PITCH, pitch))

/**
 * First-person 360° shaded terrain from the eye, at true proportions (1° up is as
 * large as 1° across). Drag or use the arrow keys to look around.
 */
export default function FirstPersonTerrain({ terrain, height = 440 }) {
  const wrapRef = useRef(null)
  const glRef = useRef(null)
  const overlayRef = useRef(null)
  const width = useWidth(wrapRef)
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

  const scale = useMemo(
    () => makeViewScale({ width, height: viewHeight, heading, pitch: viewPitch, fov, exaggeration: 1 }),
    [width, viewHeight, heading, viewPitch, fov],
  )

  useEffect(() => {
    const dpr = sizeCanvas(glRef.current, width, viewHeight)
    sizeCanvas(overlayRef.current, width, viewHeight)
    const frame = requestAnimationFrame(() => {
      rendererRef.current?.draw({ heading, pitch: viewPitch, fov, width, height: viewHeight })
      drawOverlay(overlayRef.current.getContext('2d'), scale, dpr)
    })
    return () => cancelAnimationFrame(frame)
  }, [scale, heading, viewPitch, fov, width, viewHeight, terrain])

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
      <div className="v2-canvas-wrap" ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown}>
        <CompassStrip heading={heading} fov={fov} />
        <div className="v2-stack" style={{ height: viewHeight }}>
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
        <span className="v2-muted">Pitch {viewPitch.toFixed(1)}° · drag or arrow keys (Shift = 1°)</span>
      </div>
    </div>
  )
}

/** Elevation labels and eye-level line. */
function drawOverlay(ctx, scale, dpr) {
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
}

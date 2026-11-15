import { useEffect, useMemo, useRef, useState } from 'react'
import { ELEVATION_COLORS, lookAt, multiply, perspective, project } from './terrainRenderer.js'
import { sizeCanvas, useWidth } from './useCanvasSize.js'
import { useTerrainRenderer } from './useTerrainRenderer.js'

const FOV_Y_DEG = 45
const TILT_MIN = 5
const TILT_MAX = 89
const elevationGradient = `linear-gradient(to right in srgb, ${ELEVATION_COLORS.join(', ')})`
const formatElevation = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

/**
 * Overhead view of the landing site: a perspective camera orbiting the site
 * centre (the ground under the observer). Drag to orbit, scroll to zoom.
 * True vertical scale (no exaggeration). The amber circle is the landing-site
 * boundary; the yellow marker is the observer's eye.
 */
export default function OverheadTerrain({ terrain, lighting = { mode: 'fixed' }, overlay = null, height = 440 }) {
  const wrapRef = useRef(null)
  const glRef = useRef(null)
  const overlayRef = useRef(null)
  const width = useWidth(wrapRef)
  const diameter = terrain.header.site.diameter_km * 1000
  const eye = terrain.header.site.eye_height_m
  const [yaw, setYaw] = useState(0) // compass direction the camera looks towards
  const [tilt, setTilt] = useState(40) // degrees above the horizontal
  const [distance, setDistance] = useState(1.4 * diameter)
  const [showElevation, setShowElevation] = useState(true)
  const drag = useRef(null)
  const { rendererRef, geometry, error } = useTerrainRenderer(glRef, terrain)

  const { viewProj, camera } = useMemo(() => {
    const target = [0, 0, -eye] // ground at the site centre, in ENU from the eye
    const y = (yaw * Math.PI) / 180
    const t = (tilt * Math.PI) / 180
    const cam = [
      target[0] - distance * Math.cos(t) * Math.sin(y),
      target[1] - distance * Math.cos(t) * Math.cos(y),
      target[2] + distance * Math.sin(t),
    ]
    const proj = perspective(FOV_Y_DEG, width / height, distance / 100, distance * 20 + 400_000)
    return { viewProj: multiply(proj, lookAt(cam, target)), camera: cam }
  }, [yaw, tilt, distance, eye, width, height])

  useEffect(() => {
    rendererRef.current?.setOverlay(overlay)
  }, [rendererRef, geometry, overlay])

  useEffect(() => {
    const dpr = sizeCanvas(glRef.current, width, height)
    sizeCanvas(overlayRef.current, width, height)
    const frame = requestAnimationFrame(() => {
      rendererRef.current?.draw({ viewProj, camera, lighting, showElevation, dpr })
      drawOverlay(overlayRef.current.getContext('2d'), viewProj, width, height, dpr, diameter, eye)
    })
    return () => cancelAnimationFrame(frame)
  }, [rendererRef, geometry, viewProj, camera, lighting, overlay, showElevation, width, height, diameter, eye])

  useEffect(() => {
    const el = glRef.current
    const onWheel = (e) => {
      e.preventDefault()
      setDistance((d) => Math.min(Math.max(d * Math.exp(e.deltaY * 0.001), diameter * 0.05), diameter * 20))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [diameter])

  function onPointerDown(e) {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, yaw, tilt }
  }
  function onPointerMove(e) {
    const d = drag.current
    if (!d) return
    setYaw((((d.yaw - (e.clientX - d.x) * 0.3) % 360) + 360) % 360)
    setTilt(Math.min(TILT_MAX, Math.max(TILT_MIN, d.tilt + (e.clientY - d.y) * 0.3)))
  }

  return (
    <div className="v2-overhead">
      <div className="v2-canvas-wrap" ref={wrapRef}>
        <div className="v2-stack" style={{ height }}>
          <canvas
            ref={glRef}
            className="v2-gl draggable"
            style={{ width, height }}
            role="img"
            aria-label={`Overhead ${showElevation ? 'elevation map' : 'shaded terrain'} of the ${terrain.header.site.diameter_km} km landing site`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => { drag.current = null }}
            onPointerCancel={() => { drag.current = null }}
          />
          <canvas ref={overlayRef} className="v2-overlay" style={{ width, height }} aria-hidden="true" />
        </div>
      </div>
      {error && <p className="v2-error">{error}</p>}
      <div className="v2-controls">
        <span>Looking {Math.round(yaw)}° · tilt {Math.round(tilt)}° · camera {(distance / 1000).toFixed(1)} km from the centre</span>
        <button type="button" onClick={() => { setYaw(0); setTilt(40); setDistance(1.4 * diameter) }}>Reset view</button>
        <button type="button" onClick={() => { setTilt(TILT_MAX) }}>Top down</button>
        <label>
          <input type="checkbox" checked={showElevation} onChange={(e) => setShowElevation(e.target.checked)} />
          Colour by elevation
        </label>
        <span className="v2-muted">Drag to orbit, scroll to zoom. True vertical scale.</span>
      </div>
      {showElevation && !error && overlay?.mode !== 'heat' && <ElevationLegend range={geometry.elevationRange} />}
    </div>
  )
}

function ElevationLegend({ range: [min, max] }) {
  return (
    <figure className="v2-elevation-legend">
      <figcaption>Elevation relative to the 1,737.4 km lunar reference sphere</figcaption>
      {min === max ? (
        <span>{formatElevation.format(min)} m across the site</span>
      ) : (
        <>
          <div className="v2-elevation-ramp" style={{ background: elevationGradient }} aria-hidden="true" />
          <div className="v2-elevation-labels">
            <span>{formatElevation.format(min)} m</span>
            <span>{formatElevation.format((min + max) / 2)} m</span>
            <span>{formatElevation.format(max)} m</span>
          </div>
        </>
      )}
    </figure>
  )
}

function drawOverlay(ctx, viewProj, width, height, dpr, diameter, eye) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.font = '12px system-ui, sans-serif'
  ctx.textAlign = 'center'
  const label = (text, p, colour) => {
    if (!p) return
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'
    ctx.fillStyle = colour
    ctx.strokeText(text, p[0], p[1])
    ctx.fillText(text, p[0], p[1])
  }
  // Observer: a short vertical tick from the ground to the eye, and a dot at the eye.
  const ground = project(viewProj, [0, 0, -eye], width, height)
  const eyeP = project(viewProj, [0, 0, Math.max(eye, diameter * 0.01)], width, height)
  if (ground && eyeP) {
    ctx.strokeStyle = '#ffd43b'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(ground[0], ground[1])
    ctx.lineTo(eyeP[0], eyeP[1])
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(eyeP[0], eyeP[1], 4, 0, 2 * Math.PI)
    ctx.fillStyle = '#ffd43b'
    ctx.fill()
    label('You', [eyeP[0], eyeP[1] - 10], '#ffd43b')
  }
  // North, east, south, west just outside the site boundary.
  const r = (diameter / 2) * 1.12
  for (const [text, x, y] of [['N', 0, r], ['E', r, 0], ['S', 0, -r], ['W', -r, 0]]) {
    label(text, project(viewProj, [x, y, -eye], width, height), 'rgba(255,255,255,0.9)')
  }
}

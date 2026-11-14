import { useEffect, useMemo, useRef, useState } from 'react'
import { DEPTH_LUT, distanceColour, rgb } from '../lib/colormap.js'
import { contourPoints, crests, depth, traceColumnChains } from '../lib/lines.js'
import {
  azimuthIndex,
  compassName,
  elevationStep,
  formatDistance,
  formatHeight,
  isHidden,
  makeViewScale,
  segmentAt,
} from '../lib/view.js'

const GRID = 'rgba(255,255,255,0.07)'
const EYE_LEVEL = 'rgba(255, 212, 59, 0.8)'

// One line style for every line (ridge crests, skyline, distance contours):
// the same width, solid, over the same thin dark casing. Only its grey shade
// changes with distance, like the fills.
const LINE_WIDTH = 1.3
const CASING = 'rgba(0,0,0,0.55)'

// Terrain fills are the distance shade, darkened, so the lines stand out.
// Fills are dimmest for the nearest ground and a little brighter far away.
const FILL_BRIGHTNESS_NEAR = 0.24
const FILL_BRIGHTNESS_FAR = 0.42

// Segment fields from the backend (see LandscapeData.segment_fields).
const LOW = 0
const HIGH = 1
const NEAR = 2
const FAR = 3
const SHADE = 4
const EDGE = 5
const HEIGHT = 6

/**
 * Draws the visible landscape for a view window onto a canvas, at true
 * proportions (one degree up is as large on screen as one degree across).
 *
 * Rendering (back to front):
 *   1. black sky
 *   2. terrain faces filled with a muted grey distance shade, as a smooth
 *      ramp from each segment's near distance (bottom) to far (top)
 *   3. lines, all in one style: distance contours and ridge crests (every
 *      crest hiding terrain behind it, and the skyline), traced across
 *      directions into whole lines and smoothed
 *   4. eye-level reference line
 * Distance shade: lib/colormap.js (greys: darker = nearer, lighter = farther).
 *
 * Props: data (ViewResponse), heading, pitch, fov, height (px), optional
 * `bodies` ({sun, earth} SPICE samples) drawn on a separate overlay canvas so
 * playback never redraws the terrain, plus optional pointer handlers for dragging.
 * Sun/Earth use the same axes as the terrain: azimuth clockwise from north,
 * elevation above the local horizontal plane.
 */
export default function LandscapeCanvas({ data, heading, pitch, fov, height, className, bodies, ...handlers }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const markersRef = useRef(null)
  const [width, setWidth] = useState(800)
  const [hover, setHover] = useState(null)

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.floor(entry.contentRect.width))))
    observer.observe(wrapRef.current)
    return () => observer.disconnect()
  }, [])

  const { landscape, skyline } = data

  const scale = useMemo(
    () => makeViewScale({ width, height, heading, pitch, fov, exaggeration: 1 }),
    [width, height, heading, pitch, fov],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(width * dpr)
    const h = Math.round(height * dpr)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    draw(canvas.getContext('2d'), scale, landscape, dpr)
  }, [scale, landscape, width, height, data])

  useEffect(() => {
    const canvas = markersRef.current
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    drawBodies(canvas.getContext('2d'), scale, bodies, skyline, dpr)
  }, [scale, bodies, skyline, width, height])

  function onPointerMove(event) {
    handlers.onPointerMove?.(event)
    const rect = canvasRef.current.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const az = scale.azAt(x)
    const el = scale.elAt(y)
    const i = azimuthIndex(landscape.azimuth_deg, az)
    setHover({
      x,
      y,
      az,
      el,
      seg: segmentAt(landscape.segments[i], el),
      skyEl: skyline.elevation_deg[i],
      skyKm: skyline.distance_km[i],
      skyHeight: skyline.terrain_m[i],
    })
  }

  return (
    <div ref={wrapRef} className={`landscape ${className ?? ''}`}>
      {/* Re-keyed per site/eye height so a new view fades in. */}
      <div key={`${data.site.lat},${data.site.lon},${data.skyline.observer_height_m}`} className="fade-in">
        <canvas
          ref={canvasRef}
          style={{ width: `${width}px`, height: `${height}px` }}
          {...handlers}
          onPointerMove={onPointerMove}
          onPointerLeave={(e) => {
            handlers.onPointerLeave?.(e)
            setHover(null)
          }}
          role="img"
          aria-label={`Landscape view facing ${Math.round(heading)} degrees (${compassName(heading)})`}
        />
        <canvas ref={markersRef} className="sky-markers" style={{ width: `${width}px`, height: `${height}px` }} aria-hidden="true" />
      </div>
      {hover && <HoverInfo hover={hover} eyeM={data.site_info.eye_m} width={width} />}
    </div>
  )
}

const BODY_STYLE = { sun: ['Sun', '#f5b301'], earth: ['Earth', '#3b82f6'] }
const MIN_MARKER_RADIUS_PX = 5

/** Sun/Earth discs at their true angular size (minimum 5 px so they stay visible). */
function drawBodies(ctx, scale, bodies, skyline, dpr) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, scale.width, scale.height)
  if (!bodies) return
  ctx.font = '12px system-ui, sans-serif'
  ctx.textAlign = 'center'
  for (const [key, [label, colour]] of Object.entries(BODY_STYLE)) {
    const b = bodies[key]
    if (!b) continue
    const x = scale.x(b.azimuth_deg)
    if (x === null) continue
    const y = scale.y(b.elevation_deg)
    const r = Math.max(b.angular_radius_deg * scale.pxPerDegY, MIN_MARKER_RADIUS_PX)
    if (y < -r || y > scale.height + r) continue
    const hidden = isHidden(b, skyline)
    ctx.globalAlpha = hidden ? 0.45 : 1
    ctx.beginPath()
    ctx.arc(x, y, r, 0, 2 * Math.PI)
    ctx.fillStyle = colour
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(0,0,0,0.7)'
    if (hidden) ctx.setLineDash([3, 2])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    const note = b.elevation_deg < 0 ? ' (below horizon)' : hidden ? ' (behind terrain)' : ''
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'
    ctx.fillStyle = '#fff'
    ctx.strokeText(label + note, x, y - r - 6)
    ctx.fillText(label + note, x, y - r - 6)
  }
}

function draw(ctx, scale, landscape, dpr) {
  const { width, height } = scale
  const { azimuth_deg: azimuths, segments } = landscape

  // Per screen column: ridge crests and contour points.
  const crestCols = []
  const contourCols = []
  for (let x = 0; x < width; x++) {
    const i = azimuthIndex(azimuths, scale.azAt(x + 0.5))
    const strip = segments[i]
    crestCols.push(crests(strip).map((c) => ({ y: scale.y(c.el), km: c.km })))
    contourCols.push(contourPoints(strip).map((c) => ({ y: scale.y(c.el), km: c.km })))
  }

  // 1-2. Sky and shaded terrain, written straight into a pixel buffer.
  // Depth is linear in log-distance, so interpolating it linearly between a
  // segment's near (bottom) and far (top) ends is exact.
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  const image = ctx.createImageData(W, H)
  const px = image.data
  for (let k = 3; k < px.length; k += 4) px[k] = 255 // opaque black sky
  for (let X = 0; X < W; X++) {
    const strip = segments[azimuthIndex(azimuths, scale.azAt((X + 0.5) / dpr))]
    for (const seg of strip) {
      const yTop = scale.y(seg[HIGH]) * dpr
      const yBottom = scale.y(seg[LOW]) * dpr
      if (yBottom <= 0 || yTop >= H) continue
      const dNear = depth(seg[NEAR])
      const dFar = depth(seg[FAR])
      const bright = 0.85 + 0.3 * Math.min(Math.max((seg[SHADE] - 0.25) / 0.75, 0), 1) // slope shading
      const span = Math.max(yBottom - yTop, 1e-6)
      const first = Math.max(Math.ceil(yTop), 0)
      const last = Math.min(Math.floor(yBottom), H - 1)
      for (let Y = first; Y <= last; Y++) {
        const d = dNear + (dFar - dNear) * ((yBottom - Y) / span)
        const c = Math.round(d * 255) * 3
        const k = (Y * W + X) * 4
        const level = bright * (FILL_BRIGHTNESS_NEAR + (FILL_BRIGHTNESS_FAR - FILL_BRIGHTNESS_NEAR) * d)
        px[k] = DEPTH_LUT[c] * level
        px[k + 1] = DEPTH_LUT[c + 1] * level
        px[k + 2] = DEPTH_LUT[c + 2] * level
      }
    }
  }
  ctx.putImageData(image, 0, 0)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  // Elevation gridlines (faint) and labels.
  ctx.font = '11px system-ui, sans-serif'
  const step = elevationStep(height / scale.pxPerDegY)
  ctx.strokeStyle = GRID
  ctx.lineWidth = 1
  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  for (let el = Math.ceil(scale.elAt(height) / step) * step; el <= scale.elAt(0); el += step) {
    const y = Math.round(scale.y(el)) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
    ctx.fillText(`${+el.toFixed(2)}°`, 4, y - 3)
  }

  // 3. Lines: contours and ridge crests, traced into whole smoothed lines,
  // all in one style; farthest first so nearer lines sit on top.
  const lines = [
    ...traceColumnChains(contourCols, { maxRatio: 1.001, maxDy: 6 }),
    ...traceColumnChains(crestCols, { maxRatio: 1.35, maxDy: 10 }),
  ].sort((a, b) => b.km - a.km)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const line of lines) {
    const path = smoothPath(line.pts)
    ctx.strokeStyle = CASING
    ctx.lineWidth = LINE_WIDTH + 1.5
    ctx.stroke(path)
    ctx.strokeStyle = rgb(distanceColour(line.km))
    ctx.lineWidth = LINE_WIDTH
    ctx.stroke(path)
  }

  // 4. Eye-level line and key.
  const yEye = Math.round(scale.y(0)) + 0.5
  if (yEye > 0 && yEye < height) {
    ctx.setLineDash([6, 4])
    ctx.strokeStyle = EYE_LEVEL
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, yEye)
    ctx.lineTo(width, yEye)
    ctx.stroke()
    ctx.setLineDash([])
  }
  badge(ctx, width - 8, height - 8, [['eye level', EYE_LEVEL]])
}

/** Smooth curve through points: quadratic curves through midpoints. */
function smoothPath(pts) {
  const path = new Path2D()
  path.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length - 1; i++) {
    path.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2)
  }
  path.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1])
  return path
}

function badge(ctx, right, bottom, items) {
  ctx.font = '12px system-ui, sans-serif'
  const gap = 14
  const widths = items.map(([text]) => ctx.measureText(text).width + 18)
  const total = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1) + 12
  let x = right - total
  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.fillRect(x, bottom - 20, total, 20)
  x += 6
  items.forEach(([text, colour], k) => {
    ctx.fillStyle = colour
    ctx.fillRect(x, bottom - 11, 12, 2)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fillText(text, x + 16, bottom - 6)
    x += widths[k] + gap
  })
}

function HoverInfo({ hover, eyeM, width }) {
  const { x, y, az, el, seg, skyEl, skyKm, skyHeight } = hover
  const left = Math.min(Math.max(x + 14, 0), width - 270)
  const swatch = seg ? rgb(distanceColour(seg[FAR])) : 'transparent'
  return (
    <div className="view-hover" style={{ left, top: Math.max(y - 84, 4) }}>
      <div className="hover-title">
        {az.toFixed(1)}° {compassName(az)} · {el >= 0 ? '+' : ''}
        {el.toFixed(2)}° {el >= 0 ? 'above' : 'below'} eye level
      </div>
      {seg ? (
        <>
          <div className="hover-row">
            <span className="hover-swatch" style={{ background: swatch }} />
            Terrain{' '}
            {seg[NEAR] === seg[FAR] ? formatDistance(seg[FAR]) : `${formatDistance(seg[NEAR])}–${formatDistance(seg[FAR])}`}{' '}
            away{seg[EDGE] === 1 && ' (behind a nearer ridge)'}
          </div>
          <div>
            Height {formatHeight(seg[HEIGHT])} vs mean level · {formatHeight(seg[HEIGHT] - eyeM)} vs your eyes
          </div>
        </>
      ) : (
        <div>Sky</div>
      )}
      <div className="hover-meta">
        Skyline this way: {skyEl >= 0 ? '+' : ''}
        {skyEl.toFixed(2)}°, {formatDistance(skyKm)} away, {formatHeight(skyHeight)} vs mean
      </div>
    </div>
  )
}

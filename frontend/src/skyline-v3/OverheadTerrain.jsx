import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ELEVATION_COLORS, HEAT_COLORS, lookAt, multiply, perspective, project } from './terrainRenderer.js'
import { IntensityLegend } from './IlluminationPanel.jsx'
import { formatDuration } from './sequence.js'
import { sizeCanvas, useWidth } from './useCanvasSize.js'
import { useTerrainRenderer } from './useTerrainRenderer.js'

const FOV_Y_DEG = 45
const TILT_MIN = 5
const TILT_MAX = 89
const elevationGradient = `linear-gradient(to right in srgb, ${ELEVATION_COLORS.join(', ')})`
const sunlightGradient = `linear-gradient(to right in srgb, ${HEAT_COLORS.join(', ')})`
const formatElevation = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
const formatPercent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 })
const formatEnergy = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 })

/**
 * Overhead view of the landing site: a perspective camera orbiting the site
 * centre (the ground under the observer). Drag to orbit, scroll to zoom.
 * True vertical scale (no exaggeration). The amber circle is the landing-site
 * boundary; the yellow marker is the observer's eye.
 */
export default function OverheadTerrain({ terrain, lighting = { mode: 'fixed' }, overlay = null, field = null, bodies = null,
  sunNow = null, intensity = false, shadowHeightM = 0.5, frameKey, height = 440, missionLayer = null }) {
  const wrapRef = useRef(null)
  const glRef = useRef(null)
  const overlayRef = useRef(null)
  const measuredWidth = useWidth(wrapRef)
  const width = measuredWidth ?? 800
  const diameter = terrain.header.site.diameter_km * 1000
  const eye = terrain.header.site.eye_height_m
  const [yaw, setYaw] = useState(0) // compass direction the camera looks towards
  const [tilt, setTilt] = useState(40) // degrees above the horizontal
  const { rendererRef, geometry, error } = useTerrainRenderer(glRef, terrain)
  const span = 2 * geometry.outerRadius // site plus surround
  const homeDistance = 1.15 * span
  const [distance, setDistance] = useState(homeDistance)
  const [showElevation, setShowElevation] = useState(true)
  const [drawnFrame, setDrawnFrame] = useState(null)
  const [drawError, setDrawError] = useState(null)
  const [selection, setSelection] = useState(null)
  const pointIndex = missionLayer && (selection?.points === missionLayer.points ? selection.index : missionLayer.centre)
  const point = missionLayer?.points[pointIndex]
  const reveal = frameKey !== null && drawnFrame === frameKey && !error && !drawError
  const drag = useRef(null)

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
    rendererRef.current?.setField(field, geometry.outerRadius, shadowHeightM)
  }, [rendererRef, geometry, field, shadowHeightM])

  useEffect(() => {
    // Shadows for the step's Sun: used by the sunlit view and by the intensity map.
    const sun = sunNow ? { dir: sunNow.sun, radius: sunNow.sunRadius } : null
    rendererRef.current?.setSun(sun)
  }, [rendererRef, geometry, field, shadowHeightM, sunNow])

  useEffect(() => {
    if (!frameKey || measuredWidth === null || error || drawError) return
    const frame = requestAnimationFrame(() => {
      const renderer = rendererRef.current
      if (!renderer) return
      try {
        const dpr = sizeCanvas(glRef.current, width, height)
        sizeCanvas(overlayRef.current, width, height)
        renderer.draw({ viewProj, camera, lighting, showElevation, dpr, intensity, sunNow })
        drawOverlay(overlayRef.current.getContext('2d'), viewProj, width, height, dpr, diameter, eye, bodies,
          geometry.outerRadius, point)
        if (drawnFrame !== frameKey) flushSync(() => setDrawnFrame(frameKey))
      } catch (err) {
        setDrawError(err.message)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [frameKey, drawnFrame, measuredWidth, error, drawError, rendererRef, geometry, viewProj, camera, lighting, overlay, field,
    bodies, sunNow, intensity, showElevation, width, height, diameter, eye, point])

  useEffect(() => {
    const el = glRef.current
    const onWheel = (e) => {
      e.preventDefault()
      setDistance((d) => Math.min(Math.max(d * Math.exp(e.deltaY * 0.001), diameter * 0.05), span * 10))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [diameter, span])

  function onPointerDown(e) {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, yaw, tilt, moved: false }
  }
  function onPointerMove(e) {
    const d = drag.current
    if (!d) return
    if (missionLayer && !d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return
    d.moved = true
    setYaw((((d.yaw - (e.clientX - d.x) * 0.3) % 360) + 360) % 360)
    setTilt(Math.min(TILT_MAX, Math.max(TILT_MIN, d.tilt + (e.clientY - d.y) * 0.3)))
  }

  function selectPoint(index) {
    if (missionLayer?.points[index]) setSelection({ points: missionLayer.points, index })
  }

  function onPointerUp(e) {
    const moved = drag.current?.moved
    drag.current = null
    if (!missionLayer || moved) return
    const bounds = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - bounds.left
    const y = e.clientY - bounds.top
    let best = null
    let distance = 14
    for (const [index, node] of missionLayer.points.entries()) {
      if (!node) continue
      const projected = project(viewProj, node.position, width, height)
      if (!projected) continue
      const d = Math.hypot(x - projected[0], y - projected[1])
      if (d < distance) { best = index; distance = d }
    }
    selectPoint(best)
  }

  function onMapKeyDown(e) {
    const direction = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key]
    if (!missionLayer || !point || !direction) return
    e.preventDefault()
    const origin = project(viewProj, point.position, width, height)
    if (!origin) return
    const { nx } = missionLayer.overlay
    const column = pointIndex % nx
    let best = null
    let bestAlignment = 0
    for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
        if (column + columnOffset < 0 || column + columnOffset >= nx || (!rowOffset && !columnOffset)) continue
        const index = pointIndex + rowOffset * nx + columnOffset
        const node = missionLayer.points[index]
        if (!node) continue
        const target = project(viewProj, node.position, width, height)
        if (!target) continue
        const dx = target[0] - origin[0]
        const dy = target[1] - origin[1]
        const alignment = (dx * direction[0] + dy * direction[1]) / Math.hypot(dx, dy)
        if (alignment > bestAlignment) { best = index; bestAlignment = alignment }
      }
    }
    selectPoint(best)
  }

  return (
    <div className="v2-overhead">
      <div className="v2-canvas-wrap" ref={wrapRef} style={{ visibility: reveal ? 'visible' : 'hidden' }}>
        <div className="v2-stack" style={{ height }}>
          <canvas
            ref={glRef}
            className="v2-gl draggable"
            style={{ width, height }}
            role="img"
            aria-label={missionLayer ? `${missionLayer.metric === 'energy' ? 'Solar energy map' : 'Mission sunlight map'}. Use arrow keys to select a nearby point.`
              : `Overhead ${intensity ? 'solar intensity map' : showElevation ? 'elevation map' : 'shaded terrain'} of the ${terrain.header.site.diameter_km} km landing site`}
            tabIndex={missionLayer ? 0 : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { drag.current = null }}
            onKeyDown={onMapKeyDown}
          />
          <canvas ref={overlayRef} className="v2-overlay" style={{ width, height }} aria-hidden="true" />
        </div>
      </div>
      {(error || drawError) && <p className="v2-error">{error || drawError}</p>}
      <div className="v2-controls">
        <span>Looking {Math.round(yaw)}° · tilt {Math.round(tilt)}° · camera {(distance / 1000).toFixed(1)} km from the centre</span>
        <button type="button" onClick={() => { setYaw(0); setTilt(40); setDistance(homeDistance) }}>Reset view</button>
        <button type="button" onClick={() => { setTilt(TILT_MAX) }}>Top down</button>
        {!missionLayer && !intensity && <label>
          <input type="checkbox" checked={showElevation} onChange={(e) => setShowElevation(e.target.checked)} />
          Colour by elevation
        </label>}
        {missionLayer
          ? <button type="button" onClick={() => {
            setYaw(0)
            setTilt(TILT_MAX)
            setDistance(Math.max(diameter, homeDistance * 0.65))
            selectPoint(missionLayer.best)
          }}>{missionLayer.metric === 'energy' ? 'Show highest-energy point' : 'Show longest-lit point'}</button>
          : <span className="v2-muted">Drag to orbit, scroll to zoom. True vertical scale.</span>}
      </div>
      {missionLayer && !error && <MissionLayerLegend map={missionLayer} point={point} />}
      {intensity && sunNow && !error && <IntensityLegend flux={sunNow.solarFlux} />}
      {showElevation && !error && !missionLayer && overlay?.mode !== 'heat' && !intensity &&
        <ElevationLegend range={geometry.elevationRange} />}
    </div>
  )
}

function MissionLayerLegend({ map, point }) {
  const energy = map.metric === 'energy'
  const location = point && [`${Math.abs(Math.round(point.x))} m ${point.x < 0 ? 'west' : 'east'}`,
    `${Math.abs(Math.round(point.y))} m ${point.y < 0 ? 'south' : 'north'}`].join(', ')
  return (
    <section className="v3-sunlight-readout" aria-label={energy ? 'Mission solar energy details' : 'Mission sunlight details'}>
      <figure className="v2-elevation-legend">
        <figcaption>{energy ? 'Direct solar energy received over the mission' : 'Share of mission in sunlight'}</figcaption>
        {energy && map.max === 0 ? <p>No direct solar energy recorded in the landing area.</p> : <>
          <div className="v2-elevation-ramp" style={{ background: sunlightGradient }} aria-hidden="true" />
          <div className="v2-elevation-labels">{energy
            ? <><span>0</span><span>{formatEnergy.format(map.max / 2)}</span><span>{formatEnergy.format(map.max)} kWh/m²</span></>
            : <><span>0%</span><span>50%</span><span>100%</span></>}</div>
        </>}
        <p className="v2-muted">Select a point inside the landing area.</p>
      </figure>
      {point && <div className="v3-sunlight-point" aria-live="polite">
        <strong>Selected point</strong>
        <span className="v2-muted">{location} of site centre</span>
        <dl>
          {energy && <div><dt>Solar energy received</dt><dd>{Number.isFinite(point.energy)
            ? `${formatEnergy.format(point.energy)} kWh/m²` : 'Unavailable'}</dd></div>}
          <div><dt>Time in sunlight</dt><dd>{formatDuration(point.sunlight * 3600)} · {formatPercent.format(point.sunlight / map.hours)}</dd></div>
          {!energy && <div><dt>Longest darkness</dt><dd>{formatDuration(point.darkness * 3600)}</dd></div>}
        </dl>
      </div>}
      <p className="v2-muted v2-note v3-sunlight-method">
        {energy
          ? <>Estimate for a surface aligned with the local slope. Shadows are sampled at {map.height} m above ground
            every {map.stepMinutes} min on a {Math.round(map.spacing)} m grid. Panel output depends on its mounting and efficiency.</>
          : <>Estimated at {map.height} m above ground, with samples every {map.stepMinutes} min on a {Math.round(map.spacing)} m grid.
            Sunlight counts when at least {formatPercent.format(map.visible_disc_threshold)} of the Sun is visible.</>}
        {' '}Estimates exclude eclipses and may miss brief gaps.
      </p>
    </section>
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

function drawOverlay(ctx, viewProj, width, height, dpr, diameter, eye, bodies, outerRadius, point) {
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
  if (ground && eyeP && !point) {
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
  if (point) {
    const marker = project(viewProj, point.position, width, height)
    if (marker) {
      ctx.beginPath()
      ctx.arc(marker[0], marker[1], 5, 0, 2 * Math.PI)
      ctx.strokeStyle = '#12131a'
      ctx.lineWidth = 4
      ctx.stroke()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }
  // North, east, south, west just outside the site boundary.
  const r = (diameter / 2) * 1.12
  for (const [text, x, y] of [['N', 0, r], ['E', r, 0], ['S', 0, -r], ['W', -r, 0]]) {
    label(text, project(viewProj, [x, y, -eye], width, height), 'rgba(255,255,255,0.9)')
  }
  if (bodies) drawBodyMarkers(ctx, viewProj, width, height, outerRadius, eye, bodies, label)
}

const MARKERS = [['sun', 'Sun', '#f5b301'], ['earth', 'Earth', '#4c8dff']]
const fmtDistance = (km) => (km > 1e6 ? `${(km / 1e6).toFixed(1)} million km` : `${Math.round(km).toLocaleString()} km`)

/**
 * Sun and Earth as small markers in their true direction from the site centre
 * (azimuth and elevation in the site's frame), at a schematic distance that
 * fits the current view. The label gives the real azimuth, elevation and distance.
 */
function drawBodyMarkers(ctx, viewProj, width, height, outerRadius, eye, bodies, label) {
  const centre = [0, 0, -eye]
  const ground = project(viewProj, centre, width, height)
  if (!ground) return
  for (const [key, name, colour] of MARKERS) {
    const b = bodies[key]
    const a = (b.azimuth_deg * Math.PI) / 180
    const e = (b.elevation_deg * Math.PI) / 180
    let reach = 1.1 * outerRadius
    let p = null
    for (let attempt = 0; attempt < 12; attempt++) {
      p = project(viewProj, [reach * Math.cos(e) * Math.sin(a), reach * Math.cos(e) * Math.cos(a),
        -eye + reach * Math.sin(e)], width, height)
      if (p && p[0] >= 10 && p[0] <= width - 10 && p[1] >= 25 && p[1] <= height - 10) break
      reach *= 0.65
    }
    const foot = project(viewProj, [reach * Math.cos(e) * Math.sin(a), reach * Math.cos(e) * Math.cos(a), -eye], width, height)
    if (!p) continue
    const below = b.elevation_deg < 0
    ctx.save()
    ctx.strokeStyle = colour
    ctx.globalAlpha = below ? 0.55 : 0.9
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.moveTo(ground[0], ground[1])
    ctx.lineTo(p[0], p[1])
    ctx.stroke()
    if (foot) { // the drop from the marker to the ground plane shows the elevation
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(foot[0], foot[1])
      ctx.lineTo(p[0], p[1])
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.arc(p[0], p[1], key === 'sun' ? 7 : 6, 0, 2 * Math.PI)
    ctx.fillStyle = colour
    ctx.fill()
    ctx.restore()
    const text = `${name} · az ${b.azimuth_deg.toFixed(1)}° · ${b.elevation_deg.toFixed(2)}° ${below ? 'below' : 'up'} · ${fmtDistance(b.distance_km)}`
    const halfLabel = Math.min(width / 2, ctx.measureText(text).width / 2 + 4)
    label(text, [Math.max(halfLabel, Math.min(width - halfLabel, p[0])), p[1] - 12], colour)
  }
}

import { memo, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { BODIES, PITCH_LIMIT, STATUS, lookTarget } from '../lib/celestial.js'
import { coast, easeTo } from '../lib/motion.js'
import { compassName, wrap360 } from '../lib/view.js'
import CelestialFinder from './CelestialFinder.jsx'
import CompassStrip from './CompassStrip.jsx'
import LandscapeCanvas from './LandscapeCanvas.jsx'

const FOV_OPTIONS = [60, 90, 120, 180]
const DEFAULT_VIEW_HEIGHT = 420

/**
 * Street View-style view from the observer's eye, always at true proportions
 * (one degree up is as large on screen as one degree across).
 * Turn by dragging (with momentum when you let go), the arrow keys, the
 * slider, or the buttons; key and button turns are eased, not instant.
 * Drag up/down (or Up/Down keys) to look up or down.
 *
 * Find Sun / Find Earth turn to a body and then keep it centred as the selected time
 * changes; any manual turn releases it. `bodies` are the SPICE samples for the selected
 * time and `statuses` their terrain visibility (see lib/celestial.js).
 */
function FirstPersonView({ data, viewHeight = DEFAULT_VIEW_HEIGHT, bodies, statuses, ref }) {
  const [heading, setHeadingState] = useState(180)
  const [pitch, setPitch] = useState(0)
  const [fov, setFov] = useState(120)
  const [following, setFollowing] = useState(null) // 'sun' | 'earth' | null
  const [announcement, setAnnouncement] = useState('')
  const drag = useRef(null)
  const headingRef = useRef(180) // current heading, readable inside animations
  const targetRef = useRef(180) // where eased turns are heading to
  const followRef = useRef(null) // same as `following`, readable inside the time effect
  const cancelAnim = useRef(() => {})

  useEffect(() => () => cancelAnim.current(), [])

  function setHeading(h) {
    headingRef.current = wrap360(h)
    setHeadingState(headingRef.current)
  }

  function follow(key) {
    followRef.current = key
    setFollowing(key)
  }

  /** Any manual navigation stops following a body. */
  function release() {
    if (followRef.current) follow(null)
  }

  const level = () => {
    release()
    setPitch(0)
  }

  // Lets a parent level this view (e.g. 'Align eye levels' when comparing).
  useImperativeHandle(ref, () => ({ level }), []) // eslint-disable-line react-hooks/exhaustive-deps

  /** Eased turn by `deg`; repeated presses add up smoothly. */
  function turn(deg) {
    release()
    cancelAnim.current()
    targetRef.current = wrap360(targetRef.current + deg)
    cancelAnim.current = easeTo(headingRef.current, targetRef.current, setHeading)
  }

  function jumpTo(h) {
    release()
    cancelAnim.current()
    targetRef.current = wrap360(h)
    setHeading(h)
  }

  const tilt = (deg) => {
    release()
    setPitch((p) => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p + deg)))
  }

  function findBody(key) {
    const b = bodies?.[key]
    if (!b) return
    const label = BODIES.find((x) => x.key === key).label
    const { heading: h, pitch: p } = lookTarget(b)
    cancelAnim.current()
    targetRef.current = h
    cancelAnim.current = easeTo(headingRef.current, h, setHeading)
    setPitch(p)
    follow(key)
    setAnnouncement(
      `Facing the ${label}: azimuth ${b.azimuth_deg.toFixed(1)}°, elevation ${b.elevation_deg.toFixed(1)}°. ` +
        `${STATUS[statuses?.[key] ?? 'pending'].text}. Following as time changes; turn the view to release.`,
    )
  }

  // Following a body: when the selected time changes, keep it centred (no animation, so
  // playback and reduced-motion users get the same behaviour).
  useEffect(() => {
    const b = followRef.current && bodies?.[followRef.current]
    if (!b) return
    const { heading: h, pitch: p } = lookTarget(b)
    cancelAnim.current()
    targetRef.current = h
    setHeading(h)
    setPitch(p)
  }, [bodies])

  function onPointerDown(event) {
    release()
    cancelAnim.current()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      heading: headingRef.current,
      pitch,
      width: event.currentTarget.clientWidth,
      samples: [{ t: performance.now(), h: headingRef.current }],
    }
  }

  function onPointerMove(event) {
    const d = drag.current
    if (!d) return
    const pxPerDeg = d.width / fov
    // Dragging the ground to the right turns you to the left, like Street View.
    const h = d.heading - (event.clientX - d.x) / pxPerDeg
    setHeading(h)
    d.samples.push({ t: performance.now(), h })
    if (d.samples.length > 6) d.samples.shift()
    const p = d.pitch + (event.clientY - d.y) / pxPerDeg
    setPitch(Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p)))
  }

  function onPointerUp() {
    const d = drag.current
    drag.current = null
    if (!d) return
    // Release speed from the last few pointer moves -> momentum.
    const first = d.samples[0]
    const last = d.samples[d.samples.length - 1]
    const dt = last.t - first.t
    const fresh = performance.now() - last.t < 60 // still moving when released
    const velocity = dt > 0 && fresh ? (last.h - first.h) / dt : 0
    targetRef.current = headingRef.current
    cancelAnim.current = coast(velocity, () => headingRef.current, (h) => {
      setHeading(h)
      targetRef.current = h
    })
  }

  function onKeyDown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const step = event.shiftKey ? 1 : 5
    const keys = {
      ArrowLeft: () => turn(-step),
      ArrowRight: () => turn(step),
      ArrowUp: () => tilt(step / 2),
      ArrowDown: () => tilt(-step / 2),
      Escape: release,
      l: level,
    }
    for (const { key, shortcut } of BODIES) keys[shortcut] = () => findBody(key)
    const action = keys[event.key.length === 1 ? event.key.toLowerCase() : event.key]
    if (action) {
      event.preventDefault()
      action()
    }
  }

  const followed = BODIES.find((b) => b.key === following)

  return (
    <section className="first-person" aria-label="First-person view">
      <div
        className="fp-viewport"
        tabIndex={0}
        role="group"
        aria-label="Interactive first-person view. Arrow keys turn and tilt, S finds the Sun, E finds Earth, L levels the view."
        onKeyDown={onKeyDown}
      >
        <CompassStrip heading={heading} fov={fov} />
        <LandscapeCanvas
          data={data}
          heading={heading}
          pitch={pitch}
          fov={fov}
          height={viewHeight}
          bodies={bodies}
          statuses={statuses}
          className="draggable"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>

      <CelestialFinder bodies={bodies} statuses={statuses} following={following} onFind={findBody} />
      <p className="follow-note" aria-hidden={!followed}>
        {followed && (
          <>
            Keeping the {followed.label} centred as time changes.{' '}
            <button type="button" className="link-button" onClick={release}>
              Stop following
            </button>
          </>
        )}
      </p>
      <p className="sr-only" role="status">
        {announcement}
      </p>

      <div className="fp-controls">
        <button type="button" onClick={() => turn(-15)} aria-label="Turn left 15 degrees">
          ◀
        </button>
        <label className="slider-field heading-slider">
          <span>
            Heading <b>{Math.round(heading) % 360}° {compassName(heading)}</b>
          </span>
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={Math.round(heading) % 360}
            aria-valuetext={`${Math.round(heading) % 360} degrees, ${compassName(heading)}`}
            onChange={(e) => jumpTo(Number(e.target.value))}
          />
        </label>
        <button type="button" onClick={() => turn(15)} aria-label="Turn right 15 degrees">
          ▶
        </button>

        <label className="slider-field">
          <span>Field of view</span>
          <select value={fov} onChange={(e) => setFov(Number(e.target.value))}>
            {FOV_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f}°
              </option>
            ))}
          </select>
        </label>

        <button type="button" onClick={level} aria-keyshortcuts="L">
          Level view
        </button>
      </div>
      <p className="hint">
        Drag to look around · arrow keys turn (Shift for 1°) · Up/Down tilt · S Sun · E Earth · L level · Esc stop following
      </p>
    </section>
  )
}

export default memo(FirstPersonView)

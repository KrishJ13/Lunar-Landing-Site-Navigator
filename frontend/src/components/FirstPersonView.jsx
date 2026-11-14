import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import { coast, easeTo } from '../lib/motion.js'
import { wrap360 } from '../lib/view.js'
import CompassStrip from './CompassStrip.jsx'
import LandscapeCanvas from './LandscapeCanvas.jsx'

// Narrow fields of view show the Sun (~0.53° across) and Earth (~1.9°) at a usable size.
const FOV_OPTIONS = [5, 10, 20, 60, 90, 120, 180]
const DEFAULT_VIEW_HEIGHT = 420
const PITCH_LIMIT = 85 // high enough to centre Earth near the zenith at narrow fields of view

/**
 * Street View-style view from the observer's eye, always at true proportions
 * (one degree up is as large on screen as one degree across).
 * Turn by dragging (with momentum when you let go), the arrow keys, the
 * slider, or the buttons; key and button turns are eased, not instant.
 * Drag up/down (or Up/Down keys) to look up or down.
 */
export default function FirstPersonView({ data, viewHeight = DEFAULT_VIEW_HEIGHT, bodies, ref }) {
  const [heading, setHeadingState] = useState(180)
  const [pitch, setPitch] = useState(0)
  const [fov, setFov] = useState(120)
  const drag = useRef(null)
  const headingRef = useRef(180) // current heading, readable inside animations
  const targetRef = useRef(180) // where eased turns are heading to
  const cancelAnim = useRef(() => {})

  useEffect(() => () => cancelAnim.current(), [])

  // Lets a parent level this view (e.g. 'Align eye levels' when comparing).
  useImperativeHandle(ref, () => ({ level: () => setPitch(0) }), [])

  function setHeading(h) {
    headingRef.current = wrap360(h)
    setHeadingState(headingRef.current)
  }

  /** Eased turn by `deg`; repeated presses add up smoothly. */
  function turn(deg) {
    cancelAnim.current()
    targetRef.current = wrap360(targetRef.current + deg)
    cancelAnim.current = easeTo(headingRef.current, targetRef.current, setHeading)
  }

  function jumpTo(h) {
    cancelAnim.current()
    targetRef.current = wrap360(h)
    setHeading(h)
  }

  const tilt = (deg) => setPitch((p) => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p + deg)))

  function onPointerDown(event) {
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
    const step = event.shiftKey ? 1 : 5
    const keys = {
      ArrowLeft: () => turn(-step),
      ArrowRight: () => turn(step),
      ArrowUp: () => tilt(step / 2),
      ArrowDown: () => tilt(-step / 2),
    }
    if (keys[event.key]) {
      event.preventDefault()
      keys[event.key]()
    }
  }

  return (
    <section className="first-person" aria-label="First-person view">
      <div className="fp-viewport" tabIndex={0} onKeyDown={onKeyDown}>
        <CompassStrip heading={heading} fov={fov} />
        <LandscapeCanvas
          data={data}
          heading={heading}
          pitch={pitch}
          fov={fov}
          height={viewHeight}
          bodies={bodies}
          className="draggable"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>

      <div className="fp-controls">
        <button type="button" onClick={() => turn(-15)} aria-label="Turn left 15 degrees">
          ◀
        </button>
        <label className="slider-field heading-slider">
          <span>Heading {Math.round(heading)}°</span>
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={Math.round(heading) % 360}
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

        <button type="button" className="link-button" onClick={() => setPitch(0)}>
          Level view
        </button>
      </div>
      <p className="hint">Drag to look around · arrow keys turn (Shift for 1°) · Up/Down look up or down</p>
    </section>
  )
}

// Small animation helpers for turning the view smoothly.
//
//   easeTo:  animate a compass heading to a target along the shortest way
//            round, with an ease-out curve (fast start, gentle stop).
//   coast:   after a drag is released, keep turning with the release speed
//            and let friction slow it down (momentum, as in map viewers).
// Both honour the user's "reduce motion" system setting by jumping instead.

import { angleDiff, wrap360 } from './view.js'

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

/**
 * Animate from `from` to `to` (degrees). Calls onFrame(heading) each frame.
 * Returns a cancel function.
 */
export function easeTo(from, to, onFrame, durationMs = 320) {
  if (prefersReducedMotion()) {
    onFrame(wrap360(to))
    return () => {}
  }
  const delta = angleDiff(to, from)
  const start = performance.now()
  let id = requestAnimationFrame(function step(now) {
    const t = Math.min((now - start) / durationMs, 1)
    onFrame(wrap360(from + delta * easeOutCubic(t)))
    if (t < 1) id = requestAnimationFrame(step)
  })
  return () => cancelAnimationFrame(id)
}

/**
 * Keep turning at `velocity` degrees/ms, slowing with friction.
 * `getHeading` reads the current heading; onFrame sets it. Returns cancel.
 */
export function coast(velocity, getHeading, onFrame, friction = 0.994) {
  if (prefersReducedMotion() || Math.abs(velocity) < 0.01) return () => {}
  let v = velocity
  let last = performance.now()
  let id = requestAnimationFrame(function step(now) {
    const dt = Math.min(now - last, 50)
    last = now
    onFrame(wrap360(getHeading() + v * dt))
    v *= Math.pow(friction, dt)
    if (Math.abs(v) > 0.003) id = requestAnimationFrame(step)
  })
  return () => cancelAnimationFrame(id)
}

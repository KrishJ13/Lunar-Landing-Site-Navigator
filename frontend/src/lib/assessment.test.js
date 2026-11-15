// Run: node --test src/lib/
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessSeries, formatDuration, formatShare, longestRun, isBlocked } from './assessment.js'

// Flat 2 deg skyline sampled every 1 deg.
const skyline = {
  azimuth_deg: Array.from({ length: 360 }, (_, i) => i),
  elevation_deg: Array.from({ length: 360 }, () => 2),
}
const body = (el) => ({ azimuth_deg: 100, elevation_deg: el, distance_km: 1, angular_radius_deg: 0.25 })
const sample = (sunEl, earthEl, i) => ({ timestamp_utc: `t${i}`, sun: body(sunEl), earth: body(earthEl) })

test('longestRun finds the longest matching run and flags window edges', () => {
  const s = ['hidden', 'hidden', 'visible', 'below', 'below', 'below', 'visible']
  assert.deepEqual(longestRun(s, isBlocked), { length: 3, start: 3, open: false })
  assert.equal(longestRun(['hidden', 'visible'], isBlocked).open, true)
  assert.equal(longestRun(['visible', 'hidden'], isBlocked).open, true)
  assert.equal(longestRun(['visible'], isBlocked).length, 0)
})

test('assessSeries counts terrain-aware visibility and runs per body', () => {
  // Sun: visible, visible, behind terrain (1 deg < 2 deg skyline), below horizon, visible
  const sunEl = [10, 10, 1, -5, 10]
  // Earth: always visible except a partial (centre on the skyline)
  const earthEl = [20, 20, 2, 20, 20]
  const series = { step_minutes: 60, samples: sunEl.map((el, i) => sample(el, earthEl[i], i)) }
  const a = assessSeries(series, skyline)
  assert.deepEqual(a.states.sun, ['visible', 'visible', 'hidden', 'below', 'visible'])
  assert.equal(a.states.earth[2], 'partial')
  assert.equal(a.sun.clearFraction, 3 / 5)
  assert.equal(a.sun.longestBlockedHours, 2)
  assert.equal(a.sun.longestBlockedOpen, false)
  assert.equal(a.earth.clearFraction, 1)
  assert.equal(a.earth.fullFraction, 4 / 5)
  assert.equal(a.earth.longestBlockedHours, 0)
  assert.equal(a.bothFraction, 3 / 5)
  assert.equal(a.windowHours, 4) // 5 samples, both ends included

  const allDark = { step_minutes: 60, samples: [1, 2, 3].map((i) => sample(-5, 10, i)) }
  const d = assessSeries(allDark, skyline)
  assert.equal(d.sun.longestBlockedHours, 2) // capped at the window, not 3
  assert.equal(d.sun.alwaysBlocked, true)
})

test('unknown terrain is excluded from shares, not counted as visible or blocked', () => {
  const gap = { azimuth_deg: skyline.azimuth_deg, elevation_deg: skyline.elevation_deg.map(() => NaN) }
  const a = assessSeries({ step_minutes: 30, samples: [sample(10, 10, 0)] }, gap)
  assert.equal(a.sun.unknown, 1)
  assert.equal(a.sun.clearFraction, null)
  assert.equal(a.sun.alwaysBlocked, false)
  assert.equal(a.stepHours, 0.5)
})

test('formatting', () => {
  assert.equal(formatShare(null), '—')
  assert.equal(formatShare(0.004), '0.4%')
  assert.equal(formatShare(0.995), '99.5%')
  assert.equal(formatShare(0.5), '50%')
  assert.equal(formatDuration(5), '5 h')
  assert.equal(formatDuration(52), '2 d 4 h')
  assert.equal(formatDuration(48, true), '≥ 2 d')
  assert.equal(formatDuration(0, true), '0 h')
})

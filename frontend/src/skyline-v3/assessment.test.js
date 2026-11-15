// Run: npm test
import assert from 'node:assert/strict'
import test from 'node:test'
import { assess, formatDuration, formatShare, longestRun, nextChange, runs, visibilitySeries } from './assessment.js'

// Flat 2° skyline in 1° bearing samples.
const terrain = {
  header: { skyline: { azimuth_step_deg: 1, max_range_m: 300_000 } },
  arrays: { ray_skyline_deg: new Float32Array(360).fill(2) },
}

/** A synthetic sequence: given Sun and Earth elevations per step, at fixed, well-separated azimuths. */
function sequence(sunEl, earthEl, stepMinutes = 60) {
  const count = sunEl.length
  const fill = (v) => new Float32Array(count).fill(v)
  return {
    header: {
      times: { start_utc: '2026-11-15T00:00:00Z', step_minutes: stepMinutes, count },
      site: { eye_height_m: 1.8, mast_height_m: 2 },
      grid: { nx: 2, ny: 1, spacing_m: 100 },
    },
    arrays: {
      sun_azimuth_deg: fill(90), sun_elevation_deg: Float32Array.from(sunEl), sun_angular_radius_deg: fill(0.266),
      sun_distance_km: fill(1.496e8),
      earth_azimuth_deg: fill(270), earth_elevation_deg: Float32Array.from(earthEl), earth_angular_radius_deg: fill(0.95),
      earth_distance_km: fill(384_400),
      in_disc: Uint8Array.from([1, 1]),
      mean_lit: Float32Array.from([0.25, 0.75]),
      longest_dark_h: Float32Array.from([10, 2]),
    },
  }
}

test('visibility follows the skyline: above, partly behind, hidden', () => {
  const seq = sequence([10, 2, -5], [10, 10, 10])
  const { sun, earth } = visibilitySeries(seq, terrain)
  assert.ok(sun[0] > 0.999)
  assert.ok(sun[1] > 0.4 && sun[1] < 0.6) // centre on a 2° skyline: about half
  assert.equal(sun[2], 0)
  assert.ok(earth.every((f) => f > 0.999))
})

test('the Earth covering the Sun removes it (eclipse seen from the Moon)', () => {
  const seq = sequence([20], [20])
  seq.arrays.earth_azimuth_deg[0] = 90
  const { sun } = visibilitySeries(seq, terrain)
  assert.equal(sun[0], 0)
})

test('assess counts shares and run lengths at the sampling step', () => {
  // Sun: up 3 h, down 4 h, up 1 h. Earth: up throughout except 2 h.
  const seq = sequence([10, 10, 10, -5, -5, -5, -5, 10], [10, 10, -3, -3, 10, 10, 10, 10])
  const m = assess(seq, terrain)
  assert.equal(m.count, 8)
  assert.equal(m.windowHours, 7)
  assert.equal(m.sun.visibleShare, 4 / 8)
  assert.equal(m.sun.longestBlockedHours, 4)
  assert.equal(m.sun.longestBlockedOpen, false)
  assert.equal(m.earth.visibleShare, 6 / 8)
  assert.equal(m.earth.longestBlockedHours, 2)
  assert.equal(m.bothShare, 3 / 8) // steps 0, 1 and 7
  assert.equal(m.site.meanSunlit, 0.5)
  assert.equal(m.site.bestPointSunlit, 0.75)
  assert.equal(m.startUtc, '2026-11-15T00:00:00Z')
  assert.equal(m.endUtc, '2026-11-15T07:00:00Z')
})

test('runs touching the window edge are open and capped at the window', () => {
  const m = assess(sequence([-5, -5, -5], [10, 10, 10]), terrain)
  assert.equal(m.sun.visibleShare, 0)
  assert.equal(m.sun.longestBlockedHours, 2) // 3 samples x 1 h, capped at the 2 h window
  assert.equal(m.sun.longestBlockedOpen, true)
})

test('run helpers', () => {
  const on = [0, 1, 1, 0, 1]
  assert.deepEqual(runs(5, (i) => on[i] === 1), [{ start: 1, end: 3 }, { start: 4, end: 5 }])
  assert.deepEqual(longestRun(5, (i) => on[i] === 1), { length: 2, start: 1, open: false })
  assert.equal(nextChange(5, (i) => on[i] === 1, 0), 1)
  assert.equal(nextChange(5, (i) => on[i] === 1, 4), -1)
})

test('formatting never hides a small non-zero share and marks open runs', () => {
  assert.equal(formatShare(0.004), '0.4 %')
  assert.equal(formatShare(0.996), '99.6 %')
  assert.equal(formatShare(0.99996), '99.9 %')
  assert.equal(formatShare(0.000001), '0.1 %')
  assert.equal(formatDuration(0), 'None')
  assert.equal(formatShare(1), '100 %')
  assert.equal(formatShare(null), '—')
  assert.equal(formatDuration(0.25), '15 min')
  assert.equal(formatDuration(5), '5 h')
  assert.equal(formatDuration(52, true), '≥ 2 d 4 h')
})

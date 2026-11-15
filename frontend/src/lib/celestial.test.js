// Run: node --test src/lib/celestial.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { PITCH_LIMIT, bodyStatus, formatRate, formatUtc, lookTarget } from './celestial.js'

const sky = (el) => ({
  azimuth_deg: Array.from({ length: 360 }, (_, i) => i),
  elevation_deg: Array.from({ length: 360 }, () => el),
})
const body = (el, az = 100, r = 0.27) => ({ azimuth_deg: az, elevation_deg: el, angular_radius_deg: r })

test('bodyStatus separates visible / partial / hidden / below / unknown / pending', () => {
  assert.equal(bodyStatus(body(5), sky(2)), 'visible')
  assert.equal(bodyStatus(body(2.1), sky(2)), 'partial')
  assert.equal(bodyStatus(body(1), sky(2)), 'hidden')
  assert.equal(bodyStatus(body(-5), sky(2)), 'below')
  assert.equal(bodyStatus(body(5), { azimuth_deg: [], elevation_deg: [] }), 'unknown')
  assert.equal(bodyStatus(undefined, sky(2)), 'pending')
})

test('a body below 0 deg but above a deeper skyline is visible, not "below"', () => {
  assert.equal(bodyStatus(body(-1), sky(-3)), 'visible')
})

test('lookTarget keeps the true azimuth/elevation and only clamps the tilt', () => {
  assert.deepEqual(lookTarget(body(12.5, 359.5)), { heading: 359.5, pitch: 12.5 })
  assert.equal(lookTarget(body(10, 370)).heading, 10)
  assert.equal(lookTarget(body(80)).pitch, PITCH_LIMIT)
  assert.equal(lookTarget(body(-80)).pitch, -PITCH_LIMIT)
})

test('formatUtc and formatRate', () => {
  assert.equal(formatUtc('2026-11-14T06:00:00Z'), '2026-11-14 06:00 UTC')
  assert.equal(formatUtc('2026-11-14T06:00:00+00:00'), '2026-11-14 06:00 UTC')
  assert.equal(formatRate(60, 1), '1 h/s')
  assert.equal(formatRate(60, 20), '20 h/s')
  assert.equal(formatRate(10, 1), '10 min/s')
  assert.equal(formatRate(90, 1), '1.5 h/s')
})

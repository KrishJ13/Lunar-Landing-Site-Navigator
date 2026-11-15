// Deterministic projection + visibility tests. Run: node --test src/lib/
import test from 'node:test'
import assert from 'node:assert/strict'
import { angleDiff, bodyVisibility, makeViewScale, skylineAt, wrap360 } from './view.js'

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`)
const AZ = [0, 90, 180, 270]
const EL = [-10, 0, 10, 60]

test('markers at N/E/S/W x elevations: screen offsets equal angular offsets (all headings, FOVs)', () => {
  for (const fov of [60, 90, 120, 180]) {
    for (const heading of [0, 45, 90, 180, 270, 359]) {
      for (const pitch of [0, 20, -15]) {
        const s = makeViewScale({ width: 1200, height: 600, heading, pitch, fov, exaggeration: 1 })
        for (const az of AZ) for (const el of EL) {
          const d = angleDiff(az, heading)
          const x = s.x(az)
          if (Math.abs(d) <= fov / 2) near(x, 600 + d * (1200 / fov))
          else assert.equal(x, null)
          near(s.y(el), 300 - (el - pitch) * (1200 / fov)) // 1 deg up == 1 deg across
          near(wrap360(s.azAt(600 + d * (1200 / fov))), wrap360(az)) // inverse
          near(s.elAt(s.y(el)), el)
        }
      }
    }
  }
})

test('angular separation of two markers is preserved across FOVs and headings', () => {
  for (const fov of [60, 90, 120]) for (const heading of [0, 30, 300]) {
    const s = makeViewScale({ width: 900, height: 500, heading, pitch: 0, fov, exaggeration: 1 })
    const a = heading, b = wrap360(heading + 20)
    near((s.x(b) - s.x(a)) / s.pxPerDegX, 20)
  }
})

test('cardinal at screen centre; boundary and wraparound 359 -> 0', () => {
  const s = makeViewScale({ width: 1000, height: 400, heading: 0, pitch: 0, fov: 90, exaggeration: 1 })
  near(s.x(0), 500)
  near(s.x(359), 500 - (1000 / 90))
  near(s.x(1), 500 + 1000 / 90)
  near(s.x(45), 1000)
  assert.equal(s.x(45.001), null)
  near(angleDiff(0, 359), 1)
  near(angleDiff(359, 0), -1)
})

const sky = (f) => ({ azimuth_deg: Array.from({ length: 360 }, (_, i) => i), elevation_deg: Array.from({ length: 360 }, (_, i) => f(i)) })

test('skylineAt interpolates linearly and wraps; invalid -> null', () => {
  const s = sky((i) => i) // 0..359
  near(skylineAt(s, 10.5), 10.5)
  near(skylineAt(s, 359.5), 179.5) // between 359 and 0
  const bad = sky(() => 1); bad.elevation_deg[5] = null
  assert.equal(skylineAt(bad, 4.5), null)
})

test('bodyVisibility: visible / partial / hidden / centre exactly on skyline / unknown', () => {
  const flat = sky(() => 2)
  const body = (el, az = 100.3, r = 0.27) => ({ azimuth_deg: az, elevation_deg: el, angular_radius_deg: r })
  assert.equal(bodyVisibility(body(5), flat), 'visible')
  assert.equal(bodyVisibility(body(2), flat), 'partial') // centre on skyline is NOT fully visible
  assert.equal(bodyVisibility(body(2.2), flat), 'partial') // centre above, disc clipped
  assert.equal(bodyVisibility(body(1), flat), 'hidden')
  assert.equal(bodyVisibility(body(1), { azimuth_deg: [], elevation_deg: [] }), 'unknown')
  const bad = sky(() => 2); bad.elevation_deg[100] = NaN
  assert.equal(bodyVisibility(body(50), bad), 'unknown')
  assert.equal(bodyVisibility(body(3.5, 100.3), sky((i) => (i === 101 ? 6 : 0))), 'partial') // ridge rising through the disc span
})

test('0 deg horizon alone is not used: body at +1 deg behind a 3 deg ridge is hidden; below-0 skyline lets low body show', () => {
  assert.equal(bodyVisibility({ azimuth_deg: 50, elevation_deg: 1, angular_radius_deg: 0.27 }, sky(() => 3)), 'hidden')
  assert.equal(bodyVisibility({ azimuth_deg: 50, elevation_deg: -1, angular_radius_deg: 0.27 }, sky(() => -3)), 'visible')
})

// Pure helpers for drawing the landscape view (first-person and 360° panorama).
// No React here: each function maps numbers to numbers or colours.
//
// Projection: cylindrical. Screen x is linear in azimuth, screen y is linear
// in elevation. `exaggeration` stretches the vertical: 1 means one degree up
// is the same size on screen as one degree sideways (true proportions).

export const COMPASS_POINTS = [
  [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
  [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'],
]

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

/** Wrap an angle into [0, 360). */
export function wrap360(deg) {
  return ((deg % 360) + 360) % 360
}

/** Signed difference a - b wrapped into (-180, 180]. */
export function angleDiff(a, b) {
  const d = wrap360(a - b)
  return d > 180 ? d - 360 : d
}

export function compassName(az) {
  return COMPASS_16[Math.round(wrap360(az) / 22.5) % 16]
}

/**
 * Screen mapping for a view of `width` x `height` pixels, centred on compass
 * `heading` and elevation `pitch`, showing `fov` degrees of azimuth.
 */
export function makeViewScale({ width, height, heading, pitch, fov, exaggeration }) {
  const pxPerDegX = width / fov
  const pxPerDegY = pxPerDegX * exaggeration
  return {
    width,
    height,
    heading,
    pitch,
    fov,
    exaggeration,
    pxPerDegX,
    pxPerDegY,
    /** x of an azimuth, or null if outside the view */
    x: (az) => {
      const d = angleDiff(az, heading)
      return Math.abs(d) <= fov / 2 ? width / 2 + d * pxPerDegX : null
    },
    azAt: (x) => wrap360(heading + (x - width / 2) / pxPerDegX),
    y: (el) => height / 2 - (el - pitch) * pxPerDegY,
    elAt: (y) => pitch + (height / 2 - y) / pxPerDegY,
  }
}

/** Index of the azimuth sample nearest to `az` (samples evenly spaced from 0). */
export function azimuthIndex(azimuths, az) {
  const step = azimuths.length > 1 ? azimuths[1] - azimuths[0] : 360
  return Math.round(wrap360(az) / step) % azimuths.length
}

/** The segment of a strip covering elevation `el`, or null (sky). */
export function segmentAt(strip, el) {
  for (const seg of strip) {
    if (el >= seg[0] && el <= seg[1]) return seg
  }
  return null
}

/** Format a height relative to the Moon's mean level, e.g. "+1,951 m" / "−2,786 m". */
export function formatHeight(m) {
  const r = Math.round(m)
  return `${r < 0 ? '−' : r > 0 ? '+' : ''}${Math.abs(r).toLocaleString()} m`
}

/** Compact distance for labels: "500 m", "5 km", "1.5 km", "42 km", "135 km". */
export function formatDistanceShort(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`
  if (km < 10) return `${Number.isInteger(km) ? km : km.toFixed(1)} km`
  return `${Math.round(km)} km`
}

export function formatDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`
  return `${km.toFixed(km < 10 ? 2 : km < 100 ? 1 : 0)} km`
}

/** Readable spacing for elevation gridlines, in degrees. */
export function elevationStep(degreesVisible) {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30]
  return steps.find((s) => degreesVisible / s <= 10) ?? 30
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * Skyline elevation at azimuth `az`, linearly interpolated between the two neighbouring
 * samples (wrapping 359->0). Returns null if either neighbour is missing/non-finite.
 */
export function skylineAt(skyline, az) {
  const azs = skyline?.azimuth_deg
  const els = skyline?.elevation_deg
  if (!azs?.length || azs.length !== els?.length) return null
  const n = azs.length
  const step = n > 1 ? azs[1] - azs[0] : 360
  const f = wrap360(az) / step
  const i0 = Math.floor(f) % n
  const i1 = (i0 + 1) % n
  const a = els[i0]
  const b = els[i1]
  if (!finite(a) || !finite(b)) return null
  return a + (b - a) * (f - Math.floor(f))
}

/**
 * Terrain-relative visibility of a body disc: 'visible' (whole disc above the skyline over
 * its whole azimuth span), 'hidden' (whole disc below it), 'partial', or 'unknown' when the
 * skyline is unavailable/invalid at the body's azimuth. Uses the LOLA skyline, not the 0 deg horizon.
 */
export function bodyVisibility(b, skyline) {
  const r = b.angular_radius_deg
  const half = r / Math.max(Math.cos((Math.min(Math.abs(b.elevation_deg), 89) * Math.PI) / 180), 0.05)
  const n = skyline?.azimuth_deg?.length
  if (!n) return 'unknown'
  const step = n > 1 ? skyline.azimuth_deg[1] - skyline.azimuth_deg[0] : 360
  const azs = [b.azimuth_deg - half, b.azimuth_deg, b.azimuth_deg + half]
  const lo = Math.ceil((b.azimuth_deg - half) / step)
  const hi = Math.floor((b.azimuth_deg + half) / step)
  for (let k = lo; k <= hi; k++) azs.push(k * step) // sampled azimuths inside the disc span
  let min = Infinity
  let max = -Infinity
  for (const a of azs) {
    const e = skylineAt(skyline, a)
    if (e === null) return 'unknown'
    min = Math.min(min, e)
    max = Math.max(max, e)
  }
  if (b.elevation_deg - r >= max) return 'visible'
  if (b.elevation_deg + r <= min) return 'hidden'
  return 'partial'
}

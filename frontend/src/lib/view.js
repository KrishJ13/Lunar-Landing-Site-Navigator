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

/**
 * Elevation of the top of the drawn terrain at azimuth `az`: the top of the
 * last segment in the nearest landscape strip (above it is sky). This is the
 * exact edge the terrain canvas paints, so it matches the shader cut-off.
 */
export function terrainTopAt(landscape, az) {
  const strip = landscape.segments[azimuthIndex(landscape.azimuth_deg, az)]
  return strip.length ? strip[strip.length - 1][1] : -90
}

const DISC_COLUMNS = 64

/**
 * Fraction (0..1) of a body's disc above the terrain, integrated over the
 * round on-screen disc the sky shader draws (lib/skyShader.js): radius r =
 * angular_radius_deg in screen degrees, centre (az0, el0). For column offset
 * x the chord is el0 ± h with h = sqrt(r^2 - x^2); the visible part of it is
 * clamp(el0 + h - max(el0 - h, top(az0 + x)), 0, 2h). Midpoint rule over
 * 64 columns; fraction = sum(visible) / sum(2h).
 *
 * Works for any skyline elevation, including a skyline below 0 deg (high
 * sites), where a body below the horizontal plane can still be in view.
 */
export function bodyVisibility(b, landscape) {
  const r = b.angular_radius_deg
  let seen = 0
  let total = 0
  for (let k = 0; k < DISC_COLUMNS; k++) {
    const x = r * (((k + 0.5) / DISC_COLUMNS) * 2 - 1)
    const h = Math.sqrt(r * r - x * x)
    const top = terrainTopAt(landscape, b.azimuth_deg + x)
    const lo = Math.max(b.elevation_deg - h, top)
    seen += Math.min(Math.max(b.elevation_deg + h - lo, 0), 2 * h)
    total += 2 * h
  }
  return total > 0 ? seen / total : 0
}

/**
 * Short note for a body given its visible fraction: '' when fully visible
 * (even below 0 deg, if the terrain there is lower still), else
 * 'partly behind terrain (40 % visible)', 'behind terrain' (centre above the
 * horizontal plane) or 'below horizon'.
 */
export function visibilityNote(b, fraction) {
  if (fraction >= 0.999) return ''
  if (fraction > 0.001) return `partly behind terrain (${Math.min(99, Math.max(1, Math.round(fraction * 100)))} % visible)`
  return b.elevation_deg >= 0 ? 'behind terrain' : 'below horizon'
}

// Sun and Earth on the V3 horizon. No React here.
//
// Positions come from the time sequence (POST /api/site/illumination, the same
// SPICE evaluation as GET /api/v1/positions, backend/lunar_sky/positions.py): topocentric apparent azimuth (clockwise
// from north) and elevation in the site's East/North/Up frame, LT+S, frame
// MOON_ME_DE440_ME421 (the LOLA frame), observer at elevation_m above the
// 1737.4 km sphere. V3 passes elevation_m = ground + eye height, the same eye
// the ray-cast skyline is computed from.
//
// Terrain cut-off: V3's own ray-cast skyline (arrays.ray_skyline_deg), read
// with linear interpolation between bearing samples, exactly as the panorama
// shader draws its sky edge (panoramaRenderer.js).

export const BODY_STYLE = { sun: { label: 'Sun', colour: '#f5b301' }, earth: { label: 'Earth', colour: '#4c8dff' } }

/** Skyline elevation (deg) at any azimuth: linear between bearing samples, wrapping at 360°. */
export function skylineAt(terrain, azimuth) {
  const values = terrain.arrays.ray_skyline_deg
  const step = terrain.header.skyline.azimuth_step_deg
  const n = values.length
  const a = ((azimuth % 360) + 360) % 360
  const west = Math.min(Math.floor(a / step), n - 1)
  const east = (west + 1) % n
  const interval = east === 0 ? 360 - west * step : step
  const t = Math.min(Math.max((a - west * step) / interval, 0), 1)
  return values[west] + (values[east] - values[west]) * t
}

const DISC_COLUMNS = 64

/**
 * Fraction (0..1) of a body's round disc above the terrain. The disc has
 * radius r = angular_radius_deg in screen degrees (as it is drawn, and as
 * lib/view.js bodyVisibility in the original Skyline). For column offset x
 * the chord is el0 ± h, h = sqrt(r² − x²), and its visible part is
 * clamp(el0 + h − max(el0 − h, skyline(az0 + x)), 0, 2h).
 * Midpoint rule over 64 columns; fraction = Σ visible / Σ 2h.
 */
export function visibleFraction(body, terrain) {
  const r = body.angular_radius_deg
  let seen = 0
  let total = 0
  for (let k = 0; k < DISC_COLUMNS; k++) {
    const x = r * (((k + 0.5) / DISC_COLUMNS) * 2 - 1)
    const h = Math.sqrt(r * r - x * x)
    const low = Math.max(body.elevation_deg - h, skylineAt(terrain, body.azimuth_deg + x))
    seen += Math.min(Math.max(body.elevation_deg + h - low, 0), 2 * h)
    total += 2 * h
  }
  return total > 0 ? seen / total : 0
}

/** '' when fully visible, else a short note on what hides the body. */
export function visibilityNote(body, fraction) {
  if (fraction >= 0.999) return ''
  if (fraction > 0.001) return `partly behind terrain, ${Math.min(99, Math.max(1, Math.round(fraction * 100)))} % visible`
  return body.elevation_deg >= 0 ? 'behind terrain' : 'below the horizon'
}

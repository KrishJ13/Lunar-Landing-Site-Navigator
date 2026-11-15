import { seenAt } from './sequence.js'

const MOON_RADIUS_M = 1_737_400

/** Build the mission overlay once per result. Each texel stores value and a validity mask. */
export function buildMissionSunlight(result) {
  const { header, arrays } = result
  const metadata = header.mission_sunlight
  const hours = arrays.mission_sunlit_h
  if (!metadata || hours?.length !== arrays.in_disc.length || arrays.mission_longest_dark_h?.length !== hours.length) return null
  let centre = null
  let bestDistance = Infinity
  const points = Array.from(hours, (value, index) => {
    if (!arrays.in_disc[index] || !Number.isFinite(value)) return null
    const x = arrays.node_site_xy_m[index * 2]
    const y = arrays.node_site_xy_m[index * 2 + 1]
    const distance = Math.hypot(x, y)
    const angle = distance / MOON_RADIUS_M
    const radius = MOON_RADIUS_M + arrays.ground_m[index]
    const scale = distance ? radius * Math.sin(angle) / distance : 1
    if (distance < bestDistance) {
      centre = index
      bestDistance = distance
    }
    return {
      position: [x * scale, y * scale, radius * Math.cos(angle) - (MOON_RADIUS_M + header.site.eye_m)],
      x, y, sunlight: value, darkness: arrays.mission_longest_dark_h[index],
      energy: arrays.mission_solar_energy_kwh_m2?.[index],
    }
  })
  const map = {
    ...metadata, points, centre, spacing: header.grid.spacing_m,
    height: header.site.mast_height_m, stepMinutes: header.times.step_minutes,
  }
  const grid = seenAt(result, 0)
  return {
    mission: buildLayer(map, grid, 'sunlight', map.hours),
    energy: buildLayer(map, grid, 'energy'),
  }
}

function buildLayer(map, grid, metric, fixedMax) {
  let best = null
  let bestValue = -Infinity
  let bestDistance = Infinity
  for (const [index, point] of map.points.entries()) {
    const value = point?.[metric]
    if (!Number.isFinite(value)) continue
    const distance = Math.hypot(point.x, point.y)
    if (value > bestValue || (value === bestValue && distance < bestDistance)) {
      best = index
      bestValue = value
      bestDistance = distance
    }
  }
  if (best === null) return null
  const max = fixedMax ?? bestValue
  const values = new Uint8Array(map.points.length * 2)
  for (const [index, point] of map.points.entries()) {
    const value = point?.[metric]
    if (!Number.isFinite(value)) continue
    values[index * 2] = max > 0 ? Math.round(255 * Math.min(1, Math.max(0, value / max))) : 0
    values[index * 2 + 1] = 255
  }
  return { ...map, metric, max, best, overlay: { ...grid, values, mode: 'mission' } }
}

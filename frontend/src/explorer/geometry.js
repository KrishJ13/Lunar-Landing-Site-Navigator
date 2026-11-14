const RADIANS = Math.PI / 180
export const MOON_RADIUS_KM = 1737.4
export const POLAR_LATITUDE = 75
export const POLAR_LIMIT = Math.sin(POLAR_LATITUDE * RADIANS)
export const SELECTION_DIAMETER_KM = 10
export const CSS_PIXELS_PER_INCH = 96
export const MIN_KM_PER_INCH = 10

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const unit = (v) => v.map((x) => x / Math.hypot(...v))

function fromCoordinates(lat, lon) {
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
}

export function surfaceNormal(latitude, longitude) {
  return fromCoordinates(latitude * RADIANS, longitude * RADIANS)
}

export function parseCoordinatePair(input) {
  const parts = input.trim().replaceAll('−', '-').split(/(?:\s*,\s*|\s+)/)
  if (parts.length !== 2 || parts.some((part) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(part))) return null
  const [latitude, longitude] = parts.map(Number)
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { latitude, longitude }
}

function toRadians([x, y, z]) {
  return [Math.atan2(z, Math.hypot(x, y)), Math.atan2(y, x)]
}

export function coordinates(normal) {
  const [lat, lon] = toRadians(normal)
  return { lat: lat / RADIANS, lon: lon / RADIANS }
}

export function cameraFor(ephemeris, orbit) {
  const earth = unit(ephemeris.observer_km)
  const [earthLat, earthLon] = toRadians(earth)
  const earthEast = unit(cross([0, 0, 1], earth))
  const north = unit(cross(earth, earthEast))
  const roll = Math.atan2(dot(ephemeris.celestial_north, earthEast), dot(ephemeris.celestial_north, north))
  const latitude = (orbit.latitude ?? earthLat / RADIANS) * RADIANS
  const longitude = (orbit.longitude ?? earthLon / RADIANS) * RADIANS
  const normal = fromCoordinates(latitude, longitude)
  const east = [-Math.sin(longitude), Math.cos(longitude), 0]
  const localNorth = unit(cross(normal, east))
  const up = localNorth.map((v, i) => v * Math.cos(roll) + east[i] * Math.sin(roll))
  const right = cross(up, normal)
  const distance = Math.hypot(...ephemeris.observer_km) / MOON_RADIUS_KM
  return { earth, normal, up, right, distance }
}

export function discRadius(width, height, zoom) {
  return Math.min(width, height) * 0.435 * zoom
}

export function isMapped(normal, earth) {
  // Include natural libration at the Earth's limb and the two LOLA polar caps.
  return normal[0] >= 0 || dot(normal, earth) >= 0 || Math.abs(normal[2]) >= POLAR_LIMIT
}

export function surfaceAt(x, y, width, height, zoom, camera) {
  const radius = discRadius(width, height, zoom)
  const u = (x - width / 2) / radius
  const v = (height / 2 - y) / radius
  const r2 = u * u + v * v
  if (r2 > 1) return null
  const distance = camera.distance
  const focal = Math.sqrt(distance * distance - 1)
  const root = Math.sqrt(1 - r2)
  const plane = focal / (distance + root)
  return unit(camera.normal.map((axis, i) =>
    axis * ((1 + distance * root) / (distance + root))
    + (u * camera.right[i] + v * camera.up[i]) * plane,
  ))
}

export function pickSurface(x, y, width, height, zoom, camera) {
  const normal = surfaceAt(x, y, width, height, zoom, camera)
  return normal && isMapped(normal, camera.earth) ? normal : null
}

export function zoomToward(orbit, camera, point, zoom) {
  if (!point || zoom <= orbit.zoom) return { ...orbit, zoom }
  const follow = 1 - orbit.zoom / zoom
  const target = unit(camera.normal.map((axis, i) => axis * (1 - follow) + point[i] * follow))
  const { lat, lon } = coordinates(target)
  return isMapped(target, camera.earth) ? { latitude: lat, longitude: lon, zoom } : { ...orbit, zoom }
}

export function kilometresPerPixel(width, height, zoom, camera) {
  const perspective = Math.sqrt((camera.distance - 1) / (camera.distance + 1))
  return MOON_RADIUS_KM * perspective / discRadius(width, height, zoom)
}

export function zoomLimit(width, height, camera) {
  return Math.max(1, kilometresPerPixel(width, height, 1, camera) * CSS_PIXELS_PER_INCH / MIN_KM_PER_INCH)
}

export function scaleBar(width, height, zoom, camera) {
  const kmPerPixel = kilometresPerPixel(width, height, zoom, camera)
  const target = Math.min(CSS_PIXELS_PER_INCH, width * 0.35) * kmPerPixel
  const magnitude = 10 ** Math.floor(Math.log10(target))
  const distance = ([5, 2, 1].find((step) => step * magnitude <= target) ?? 1) * magnitude
  return { distance, pixels: distance / kmPerPixel }
}

export function projectSurface(normal, width, height, zoom, camera) {
  const z = dot(normal, camera.normal)
  if (z < 1 / camera.distance || !isMapped(normal, camera.earth)) return null
  const focal = Math.sqrt(camera.distance ** 2 - 1)
  const scale = discRadius(width, height, zoom) * focal / (camera.distance - z)
  const x = width / 2 + scale * dot(normal, camera.right)
  const y = height / 2 - scale * dot(normal, camera.up)
  return { x, y }
}

// Sunlight on the V3 terrain. No React here.
//
// Direct sunlight uses Moon Explorer's surface model (explorer/globeShader.js):
//   scattering = mix(2 mu0 / (mu0 + mu), mu0, 0.19)     Lommel-Seeliger / Lambert mix
//   direct     = albedo_linear * 2.3 * scattering * (Sun not behind Earth) * seen
// mu0 = cosine of the Sun's angle from the surface normal (averaged over the
// Sun's disc), mu = cosine of the viewing angle, seen = fraction of the Sun's
// disc above the terrain at that point (horizon maps, lunar/horizon_maps.py),
// 1 where no shadow data exists. Vectors are in the site's East/North/Up frame.
//
// What you see = relief + direct, then gamma:
//   colour = (relief_linear * RELIEF + direct) ^ (1 / 2.2)
// The relief is the fixed-light shading (the "Fixed light" view) at RELIEF of
// its brightness: NOT physical (real shadowed ground gets only earthshine,
// ~1e-4 of sunlight). It keeps the terrain's shape readable in shadow, like a
// camera exposed for sunlit ground still showing dim detail.

export const ALBEDO_SRGB = 0.5 // uniform grey surface
export const EXPOSURE = 2.3 // Explorer's scale for direct sunlight
export const RELIEF = 0.12 // fixed-light relief kept in shadow, linear fraction (not physical)

/** Unit vector in the site's East/North/Up frame towards (azimuth, elevation) in degrees. */
export function enuDirection(azimuthDeg, elevationDeg) {
  const a = (azimuthDeg * Math.PI) / 180
  const e = (elevationDeg * Math.PI) / 180
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)]
}

/**
 * Fraction of the Sun's disc not covered by the Earth as seen from the site
 * (Explorer's eclipse(): the overlap area of two discs). Angular radii rs, re
 * and separation s in radians, with d = s/rs and r = re/rs:
 *   a = (d² + 1 − r²) / 2d,  b = (d² + r² − 1) / 2dr
 *   overlap = acos a + r² acos b − d √(1 − a²)   (in units of rs²)
 *   visible = 1 − overlap / π
 * Seen from the Moon the Earth (1.8–2.05°) is always larger than the Sun (0.53°).
 */
export function sunVisibleBesideEarth(sun, earth) {
  const u = enuDirection(sun.azimuth_deg, sun.elevation_deg)
  const v = enuDirection(earth.azimuth_deg, earth.elevation_deg)
  const cross = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
  const separation = Math.atan2(cross, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])
  const rs = (sun.angular_radius_deg * Math.PI) / 180
  const re = (earth.angular_radius_deg * Math.PI) / 180
  if (separation >= re + rs) return 1
  if (separation <= re - rs) return 0
  const d = separation / rs
  const r = re / rs
  const a = Math.min(1, Math.max(-1, (d * d + 1 - r * r) / (2 * d)))
  const b = Math.min(1, Math.max(-1, (d * d + r * r - 1) / (2 * d * r)))
  const overlap = Math.acos(a) + r * r * Math.acos(b) - d * Math.sqrt(Math.max(0, 1 - a * a))
  return Math.min(1, Math.max(0, 1 - overlap / Math.PI))
}

/** Uniform values for the shaders from the SPICE bodies, or fixed lighting. */
export function makeLighting(mode, bodies) {
  if (mode !== 'sun' || !bodies) return { mode: 'fixed' }
  return {
    mode: 'sun',
    sun: enuDirection(bodies.sun.azimuth_deg, bodies.sun.elevation_deg),
    sunRadius: (bodies.sun.angular_radius_deg * Math.PI) / 180,
    sunVisible: sunVisibleBesideEarth(bodies.sun, bodies.earth),
  }
}

/** GLSL shared by both views: uniforms u_sun, u_sunRadius, u_sunVisible. */
export const LIGHTING_GLSL = `
uniform vec3 u_sun;          // unit vector towards the Sun, site ENU
uniform float u_sunRadius;   // Sun's angular radius, radians
uniform float u_sunVisible;  // fraction of the Sun's disc not behind the Earth

// Mean of sin(height above the facet) over the Sun's disc: 16 strips parallel
// to the facet plane, each weighted by its chord length sqrt(1 - y^2).
float sunOnFacet(vec3 n) {
  float h0 = asin(clamp(dot(n, u_sun), -1.0, 1.0));
  if (h0 < -u_sunRadius) return 0.0;
  float sum = 0.0;
  float total = 0.0;
  for (int k = 0; k < 16; k++) {
    float y = (float(k) + 0.5) / 8.0 - 1.0;
    float w = sqrt(1.0 - y * y);
    sum += w * max(0.0, sin(h0 + y * u_sunRadius));
    total += w;
  }
  return sum / total;
}

// Linear direct sunlight on a facet. n: unit normal; toEye: unit vector to the eye.
vec3 sunDirect(vec3 n, vec3 toEye, vec3 albedoSrgb) {
  float mu0 = sunOnFacet(n);
  float mu = max(0.0, dot(n, toEye));
  float scattering = mix(2.0 * mu0 / max(0.001, mu0 + mu), mu0, 0.19);
  return pow(albedoSrgb, vec3(2.2)) * (${EXPOSURE.toFixed(2)} * scattering * u_sunVisible);
}

// reliefSrgb: the fixed-light shading; seen: fraction of the Sun above the terrain.
vec3 composeSunlit(vec3 reliefSrgb, vec3 direct, float seen) {
  vec3 linear = pow(reliefSrgb, vec3(2.2)) * ${RELIEF.toFixed(3)} + direct * seen;
  return pow(clamp(linear, 0.0, 1.0), vec3(1.0 / 2.2));
}
`

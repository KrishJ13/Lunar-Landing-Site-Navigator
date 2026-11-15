// Reading one time step out of the sunlight sequence (POST /api/site/illumination). No React here.

/** UTC instant of step k as "YYYY-MM-DD HH:MM". */
export function stepTime(times, k) {
  const ms = Date.parse(times.start_utc) + k * times.step_minutes * 60_000
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

const BODY_KEYS = ['azimuth_deg', 'elevation_deg', 'distance_km', 'angular_radius_deg']

/** Sun and Earth seen from the eye at step k, shaped like GET /api/v1/positions. */
export function bodiesAt({ header, arrays }, k) {
  const body = (name) => Object.fromEntries(BODY_KEYS.map((key) => [key, arrays[`${name}_${key}`][k]]))
  return {
    sun: body('sun'),
    earth: body('earth'),
    timeUtc: `${stepTime(header.times, k).replace(' ', 'T')}:00Z`,
    site: { elevation_m: header.site.eye_m },
  }
}

/**
 * The shadow grid at step k: fraction of the Sun seen (0..255) on the lattice
 * nodes (rows = north). Nodes sit in a shared frame (backend/lunar/horizon_tiles.py);
 * a site point (x, y) is at frame A (x, y, 1), and node (i, j) at first + (i, j) spacing.
 */
export function seenAt({ header, arrays }, k) {
  const { nx, ny } = header.grid
  return {
    nx,
    ny,
    first: header.grid.first_m,
    spacing: header.grid.spacing_m,
    affine: header.grid.site_to_frame,
    radius: header.site.diameter_km * 500,
    values: arrays.lit.subarray(k * nx * ny, (k + 1) * nx * ny),
  }
}

/** Shader uniforms for a lattice grid (see GRID_GLSL). */
export function gridUniforms(gl, loc, grid) {
  const [a, b] = grid.affine
  gl.uniform3f(loc.u_gridA, a[0], a[1], a[2])
  gl.uniform3f(loc.u_gridB, b[0], b[1], b[2])
  gl.uniform4f(loc.u_gridFirst, grid.first[0], grid.first[1], grid.spacing, grid.radius)
  gl.uniform2f(loc.u_gridSize, grid.nx, grid.ny)
}

export const GRID_UNIFORMS = ['u_gridA', 'u_gridB', 'u_gridFirst', 'u_gridSize']

/** GLSL: texture coordinate on the lattice grid of a site point (x east, y north, metres). */
export const GRID_GLSL = `
uniform vec3 u_gridA;      // frame x = dot(u_gridA, (x, y, 1))
uniform vec3 u_gridB;      // frame y = dot(u_gridB, (x, y, 1))
uniform vec4 u_gridFirst;  // first node x, y (m), spacing (m), site radius (m)
uniform vec2 u_gridSize;   // nodes nx, ny
vec2 gridUv(vec2 xy) {
  vec2 frame = vec2(dot(u_gridA, vec3(xy, 1.0)), dot(u_gridB, vec3(xy, 1.0)));
  return ((frame - u_gridFirst.xy) / u_gridFirst.z + 0.5) / u_gridSize;
}
`

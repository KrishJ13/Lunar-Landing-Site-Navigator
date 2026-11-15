// Perspective renderer for the overhead view: the landing-site disc and a greyed surround.
import { ALBEDO_SRGB, LIGHTING_GLSL } from './lighting.js'
import { GRID_GLSL, GRID_UNIFORMS, gridUniforms } from './sequence.js'
import { createShadowPass, uploadField } from './shadowField.js'

export const ELEVATION_COLORS = ['#252d5b', '#346186', '#4e928e', '#a6ba8f', '#f1dfb6']
// Sequential ramp for illumination heatmaps (dark = little or no sunlight).
export const HEAT_COLORS = ['#0b0b1e', '#3b1f63', '#8a2a6b', '#d2483f', '#f59a1b', '#fcf2a3']
const heatPalette = HEAT_COLORS.flatMap((hex) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255))
const elevationPalette = ELEVATION_COLORS.flatMap((hex) =>
  [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255),
)

const VERT = `#version 300 es
in vec3 a_pos;
in vec2 a_xy;
in vec3 a_normal;
in float a_height;
uniform mat4 u_viewProj;
out vec2 v_xy;
out vec3 v_normal;
out float v_height;
out vec3 v_pos;
void main() {
  v_pos = a_pos;
  v_xy = a_xy;
  v_normal = a_normal;
  v_height = a_height;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}
`

const FRAG = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_xy;
in vec3 v_normal;
in float v_height;
in vec3 v_pos;             // site ENU metres from the eye
uniform float u_width;     // line width, device px
uniform bool u_realSun;
uniform vec3 u_camera;     // camera position, site ENU metres from the eye
uniform float u_radius;    // landing-site radius, metres
uniform bool u_showElevation;
uniform vec2 u_elevationRange;
uniform vec3 u_elevationColors[${ELEVATION_COLORS.length}];
uniform vec3 u_heatColors[${HEAT_COLORS.length}];
uniform int u_overlayMode;       // 0 none, 1 terrain shadow, 2 heatmap, 3 masked mission heatmap
uniform sampler2D u_overlay;     // lattice grid nx x ny, 0..1 (sequence.js)
uniform sampler2D u_fieldSeen;   // fraction of the Sun seen (GPU shadows), square grid over the view
uniform bool u_hasFieldSeen;
uniform float u_fieldHalf;       // half-width of that grid, m
uniform float u_inner;           // this mesh covers u_inner <= r <= u_outer (site: 0..R; surround: R..R+10 km)
uniform float u_outer;
uniform bool u_dim;              // the surround: desaturated and dimmed (not part of the site)
uniform bool u_intensity;        // colour by incident sunlight, W/m^2
uniform float u_solarFlux;       // S(t) = 1361 (1 AU / r)^2 W/m^2: full scale of the ramp
${GRID_GLSL}
out vec4 o;
${LIGHTING_GLSL}

vec3 elevationColor() {
  float span = u_elevationRange.y - u_elevationRange.x;
  float t = span > 0.0 ? clamp((v_height - u_elevationRange.x) / span, 0.0, 1.0) : 0.5;
  float index = t * float(u_elevationColors.length() - 1);
  int low = min(int(index), u_elevationColors.length() - 2);
  return mix(u_elevationColors[low], u_elevationColors[low + 1], index - float(low));
}

vec3 heatColor(float t) {
  float index = clamp(t, 0.0, 1.0) * float(u_heatColors.length() - 1);
  int low = min(int(index), u_heatColors.length() - 2);
  return mix(u_heatColors[low], u_heatColors[low + 1], index - float(low));
}

float overlayAt() {
  return texture(u_overlay, gridUv(v_xy)).r;
}

void main() {
  float r = length(v_xy);
  if (r > u_outer || r < u_inner) discard;

  vec3 col;
  float seenHere = u_hasFieldSeen ? texture(u_fieldSeen, (v_xy + u_fieldHalf) / (2.0 * u_fieldHalf)).r : 1.0;
  if (u_intensity) {
    // Incident sunlight on the local surface: E = S seen mu0 (mu0 averaged over the Sun's disc).
    vec3 n = normalize(v_normal);
    float flux = u_solarFlux * seenHere * sunOnFacet(n) * u_sunVisible;
    float shade = dot(n, normalize(vec3(-0.72, 0.6, 0.34)));
    // Square-root colour scale (as heatmaps of skewed quantities): low values stay distinguishable.
    col = heatColor(sqrt(flux / u_solarFlux)) * (0.85 + 0.25 * shade);
  } else if (u_overlayMode == 3 && !u_dim) {
    vec2 value = texture(u_overlay, gridUv(v_xy)).rg;
    col = value.g > 0.0 ? heatColor(value.r / value.g) : vec3(0.35);
  } else if (u_overlayMode == 2 && !u_dim) {  // lattice maps cover the site only
    vec3 light = normalize(vec3(-0.72, 0.6, 0.34));
    float shade = dot(normalize(v_normal), light);
    col = heatColor(overlayAt()) * (0.82 + 0.3 * shade);
  } else if (u_realSun) {
    vec3 n = normalize(v_normal);
    vec3 base = u_showElevation ? elevationColor() : vec3(${ALBEDO_SRGB.toFixed(3)});
    float fixedShade = dot(n, normalize(vec3(-0.72, 0.6, 0.34)));
    vec3 relief = u_showElevation ? base * (0.78 + 0.36 * fixedShade) : vec3(0.21 + 0.49 * max(0.0, fixedShade));
    float seen = u_hasFieldSeen ? seenHere : (u_overlayMode == 1 ? overlayAt() : 1.0);
    col = composeSunlit(relief, sunDirect(n, normalize(u_camera - v_pos), base), seen);
  } else {
    vec3 light = normalize(vec3(-0.72, 0.6, 0.34));
    float shade = dot(normalize(v_normal), light);
    col = vec3(0.21 + 0.49 * max(0.0, shade));
    if (u_showElevation) {
      col = elevationColor() * (0.78 + 0.36 * shade);
    }
  }

  if (u_dim) {
    float grey = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(grey), 0.7) * 0.6;
  }
  float edge = 1.0 - clamp(abs(r - u_radius) / max(fwidth(r), 1e-6) - (u_width * 0.5 - 0.5), 0.0, 1.0);
  col = mix(col, vec3(1.0, 0.72, 0.25), edge);
  o = vec4(col, 1.0);
}
`

const BOUNDARY_WIDTH_PX = 1.25
const SHADOW_GRID = 1024 // texels across the site and surround for GPU shadows

// Cross the east and north tangents. Use a one-sided tangent at DEM edges.
function writeNormal(positions, normals, v, east, west, north, south) {
  const ex = positions[3 * east] - positions[3 * west]
  const ey = positions[3 * east + 1] - positions[3 * west + 1]
  const ez = positions[3 * east + 2] - positions[3 * west + 2]
  const nx = positions[3 * north] - positions[3 * south]
  const ny = positions[3 * north + 1] - positions[3 * south + 1]
  const nz = positions[3 * north + 2] - positions[3 * south + 2]
  const x = ey * nz - ez * ny
  const y = ez * nx - ex * nz
  const z = ex * ny - ey * nx
  const length = Math.hypot(x, y, z)
  normals[3 * v] = length ? x / length : 0
  normals[3 * v + 1] = length ? y / length : 0
  normals[3 * v + 2] = length ? z / length : 1
}

/**
 * Vertices and faces of a square grid (n x n, rows = north) of ENU positions,
 * keeping the cells that touch the ring inner <= r <= outer.
 */
function buildMesh(n, xyAxis, pos, heights, inner, outer) {
  const xy = new Float32Array(2 * n * n)
  const normals = new Float32Array(3 * n * n)
  const finite = (v) => Number.isFinite(pos[3 * v + 2])
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = i * n + j
      xy[2 * v] = xyAxis[j]
      xy[2 * v + 1] = xyAxis[i]
      if (!finite(v)) continue
      writeNormal(pos, normals, v,
        j < n - 1 && finite(v + 1) ? v + 1 : v,
        j > 0 && finite(v - 1) ? v - 1 : v,
        i < n - 1 && finite(v + n) ? v + n : v,
        i > 0 && finite(v - n) ? v - n : v,
      )
    }
  }
  const faces = []
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const q = [i * n + j, i * n + j + 1, (i + 1) * n + j, (i + 1) * n + j + 1]
      if (!q.every(finite)) continue
      const closestX = Math.max(xyAxis[j], -xyAxis[j + 1], 0)
      const closestY = Math.max(xyAxis[i], -xyAxis[i + 1], 0)
      const far = Math.hypot(Math.max(Math.abs(xyAxis[j]), Math.abs(xyAxis[j + 1])),
        Math.max(Math.abs(xyAxis[i]), Math.abs(xyAxis[i + 1])))
      if (Math.hypot(closestX, closestY) > outer || far < inner) continue
      faces.push(q[0], q[1], q[3], q[0], q[3], q[2])
    }
  }
  return { pos, xy, normals, heights, faces: Uint32Array.from(faces), inner, outer }
}

/** The landing-site disc and, when the terrain has one, the surround ring. */
export function buildGeometry(terrain) {
  const { header, arrays } = terrain
  const radius = (header.site.diameter_km * 1000) / 2
  const site = buildMesh(header.site_grid.points, arrays.site_xy_m, arrays.site_enu_m, arrays.site_height_m, 0, radius)
  let minHeight = Infinity
  let maxHeight = -Infinity
  arrays.site_height_m.forEach((h, v) => {
    if (arrays.site_in_disc[v] && Number.isFinite(h)) {
      minHeight = Math.min(minHeight, h)
      maxHeight = Math.max(maxHeight, h)
    }
  })
  const surround = header.surround
    ? buildMesh(header.surround.points, arrays.surround_xy_m, arrays.surround_enu_m, arrays.surround_height_m,
      radius, header.surround.outer_radius_m)
    : null
  return { site, surround, radius, outerRadius: surround ? surround.outer : radius,
    elevationRange: [minHeight, maxHeight] }
}

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Terrain shader: ${gl.getShaderInfoLog(sh)}`)
  return sh
}

const UNIFORMS = ['u_viewProj', 'u_width', 'u_radius', 'u_showElevation', 'u_elevationRange', 'u_elevationColors[0]',
  'u_realSun', 'u_camera', 'u_sun', 'u_sunRadius', 'u_sunVisible', 'u_heatColors[0]', 'u_overlayMode', 'u_overlay',
  'u_fieldSeen', 'u_hasFieldSeen', 'u_fieldHalf', 'u_inner', 'u_outer', 'u_dim', 'u_intensity', 'u_solarFlux',
  ...GRID_UNIFORMS]

export function createTerrainRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: true })
  if (!gl) return null
  const prog = gl.createProgram()
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Terrain shader: ${gl.getProgramInfoLog(prog)}`)
  const loc = Object.fromEntries(UNIFORMS.map((u) => [u, gl.getUniformLocation(prog, u)]))
  gl.useProgram(prog)
  gl.uniform3fv(loc['u_elevationColors[0]'], elevationPalette)
  gl.uniform3fv(loc['u_heatColors[0]'], heatPalette)
  gl.uniform1i(loc.u_overlay, 0)
  let meshes = [] // [{ vao, buffers, mesh, dim }]
  let geom = null
  const overlayTexture = gl.createTexture()
  let overlay = null
  gl.uniform1i(loc.u_fieldSeen, 6)
  let shadows = null // { pass, field, half }: GPU shadows over the disc
  let haveShadow = false

  /** Height grids for GPU shadows (decoded POST /api/site/shadow-field) and the radius to cover, or null. */
  function setField(next, radius, lift = 0.5) {
    shadows?.pass.dispose()
    if (shadows) gl.deleteTexture(shadows.field.texture)
    shadows = null
    haveShadow = false
    if (!next) return
    const half = radius * 1.02
    const field = uploadField(gl, next, 5)
    const pass = createShadowPass(gl, field, SHADOW_GRID, SHADOW_GRID, `
uniform float u_half;
bool groundPoint(ivec2 texel, out vec2 xy) {
  xy = -u_half + (vec2(texel) + 0.5) * (2.0 * u_half / ${SHADOW_GRID}.0);
  return true;
}
`, lift)
    shadows = { pass, field, half }
  }

  /** Bake shadows over the disc for Sun { dir, radius }, or clear them (null). */
  function setSun(sun) {
    haveShadow = false
    if (!shadows || !sun) return
    shadows.pass.run(sun, (p) => gl.uniform1f(gl.getUniformLocation(p, 'u_half'), shadows.half))
    haveShadow = true
  }

  /** Values 0..255 on the lattice grid (sequence.js seenAt plus a mode), or null. */
  function setOverlay(next) {
    overlay = next
    if (!next) return
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, overlayTexture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const masked = next.mode === 'mission'
    gl.texImage2D(gl.TEXTURE_2D, 0, masked ? gl.RG8 : gl.R8, next.nx, next.ny, 0,
      masked ? gl.RG : gl.RED, gl.UNSIGNED_BYTE, next.values)
  }

  function upload(mesh, dim) {
    const vao = gl.createVertexArray()
    const buffers = []
    const attribute = (name, data, size) => {
      const buf = gl.createBuffer()
      buffers.push(buf)
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
      const at = gl.getAttribLocation(prog, name)
      gl.enableVertexAttribArray(at)
      gl.vertexAttribPointer(at, size, gl.FLOAT, false, 0, 0)
    }
    gl.bindVertexArray(vao)
    attribute('a_pos', mesh.pos, 3)
    attribute('a_xy', mesh.xy, 2)
    attribute('a_normal', mesh.normals, 3)
    attribute('a_height', mesh.heights, 1)
    const indexBuffer = gl.createBuffer()
    buffers.push(indexBuffer)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.faces, gl.STATIC_DRAW)
    gl.bindVertexArray(null)
    return { vao, buffers, mesh, dim }
  }

  function release() {
    for (const m of meshes) {
      for (const b of m.buffers) gl.deleteBuffer(b)
      gl.deleteVertexArray(m.vao)
    }
    meshes = []
  }

  /** buildGeometry's result: the site disc, and the greyed surround when present. */
  function setGeometry(g) {
    release()
    meshes = [upload(g.site, false), ...(g.surround ? [upload(g.surround, true)] : [])]
    geom = g
  }

  function draw(view) {
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    if (!geom) return
    gl.useProgram(prog)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
    gl.uniformMatrix4fv(loc.u_viewProj, false, view.viewProj)
    gl.uniform1i(loc.u_showElevation, view.showElevation ? 1 : 0)
    gl.uniform2f(loc.u_elevationRange, ...geom.elevationRange)
    gl.uniform1f(loc.u_width, BOUNDARY_WIDTH_PX * view.dpr)
    gl.uniform1f(loc.u_radius, geom.radius)
    const real = view.lighting?.mode === 'sun'
    gl.uniform1i(loc.u_realSun, real ? 1 : 0)
    if (real) {
      gl.uniform3fv(loc.u_camera, view.camera)
      gl.uniform3fv(loc.u_sun, view.lighting.sun)
      gl.uniform1f(loc.u_sunRadius, view.lighting.sunRadius)
      gl.uniform1f(loc.u_sunVisible, view.lighting.sunVisible)
    }
    gl.useProgram(prog)
    gl.uniform1i(loc.u_hasFieldSeen, haveShadow && real ? 1 : 0)
    if (haveShadow) {
      gl.activeTexture(gl.TEXTURE6)
      gl.bindTexture(gl.TEXTURE_2D, shadows.pass.texture)
      gl.uniform1f(loc.u_fieldHalf, shadows.half)
    }
    const mode = overlay ? ({ shadow: 1, heat: 2, mission: 3 }[overlay.mode] ?? 0) : 0
    gl.uniform1i(loc.u_overlayMode, mode)
    if (mode) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, overlayTexture)
      gridUniforms(gl, loc, overlay)
    }
    const intensity = Boolean(view.intensity && view.sunNow)
    gl.uniform1i(loc.u_intensity, intensity ? 1 : 0)
    if (intensity) {
      gl.uniform3fv(loc.u_sun, view.sunNow.sun)
      gl.uniform1f(loc.u_sunRadius, view.sunNow.sunRadius)
      gl.uniform1f(loc.u_sunVisible, view.sunNow.sunVisible)
      gl.uniform1f(loc.u_solarFlux, view.sunNow.solarFlux)
      gl.uniform1i(loc.u_hasFieldSeen, haveShadow ? 1 : 0)
    }
    for (const m of meshes) {
      gl.uniform1f(loc.u_inner, m.mesh.inner)
      gl.uniform1f(loc.u_outer, m.mesh.outer)
      gl.uniform1i(loc.u_dim, m.dim ? 1 : 0)
      gl.bindVertexArray(m.vao)
      gl.drawElements(gl.TRIANGLES, m.mesh.faces.length, gl.UNSIGNED_INT, 0)
    }
    gl.bindVertexArray(null)
  }

  function dispose() {
    release()
    gl.deleteTexture(overlayTexture)
    shadows?.pass.dispose()
    if (shadows) gl.deleteTexture(shadows.field.texture)
    gl.deleteProgram(prog)
  }

  return { setGeometry, setOverlay, setField, setSun, draw, dispose }
}

// ---------- overhead camera ----------

/** Column-major 4x4 perspective (fovY in degrees). */
export function perspective(fovYDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovYDeg * Math.PI) / 360)
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0])
}

/** Column-major view matrix looking from `eye` at `target`, with +Up (ENU z) up. */
export function lookAt(eye, target) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l) }
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const z = norm(sub(eye, target))
  const x = norm(cross([0, 0, 1], z))
  const y = cross(z, x)
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1])
}

export function multiply(a, b) {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k]
      out[c * 4 + r] = sum
    }
  }
  return out
}

/** Screen position (CSS px) of an ENU point under viewProj, or null if behind the camera. */
export function project(viewProj, p, width, height) {
  const m = viewProj
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]
  if (w <= 0) return null
  return [((x / w + 1) / 2) * width, ((1 - y / w) / 2) * height]
}

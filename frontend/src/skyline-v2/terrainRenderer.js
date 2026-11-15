// Perspective renderer for the overhead landing-site disc.

export const ELEVATION_COLORS = ['#252d5b', '#346186', '#4e928e', '#a6ba8f', '#f1dfb6']
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
void main() {
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
uniform float u_width;     // line width, device px
uniform float u_radius;    // landing-site radius, metres
uniform bool u_showElevation;
uniform vec2 u_elevationRange;
uniform vec3 u_elevationColors[${ELEVATION_COLORS.length}];
out vec4 o;

vec3 elevationColor() {
  float span = u_elevationRange.y - u_elevationRange.x;
  float t = span > 0.0 ? clamp((v_height - u_elevationRange.x) / span, 0.0, 1.0) : 0.5;
  float index = t * float(u_elevationColors.length() - 1);
  int low = min(int(index), u_elevationColors.length() - 2);
  return mix(u_elevationColors[low], u_elevationColors[low + 1], index - float(low));
}

void main() {
  float r = length(v_xy);
  if (r > u_radius) discard;

  vec3 light = normalize(vec3(-0.72, 0.6, 0.34));
  float shade = dot(normalize(v_normal), light);
  vec3 col = vec3(0.21 + 0.49 * max(0.0, shade));
  if (u_showElevation) {
    col = elevationColor() * (0.78 + 0.36 * shade);
  }

  float edge = 1.0 - clamp(abs(r - u_radius) / max(fwidth(r), 1e-6) - (u_width * 0.5 - 0.5), 0.0, 1.0);
  col = mix(col, vec3(1.0, 0.72, 0.25), edge);
  o = vec4(col, 1.0);
}
`

const BOUNDARY_WIDTH_PX = 1.25

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

/** Vertices and faces for the overhead landing-site disc. */
export function buildGeometry(terrain) {
  const { header, arrays } = terrain
  const n = header.site_grid.points
  const radius = (header.site.diameter_km * 1000) / 2
  const xyAxis = arrays.site_xy_m

  const pos = arrays.site_enu_m
  const heights = arrays.site_height_m
  const xy = new Float32Array(2 * n * n)
  const normals = new Float32Array(3 * n * n)
  let minHeight = Infinity
  let maxHeight = -Infinity

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
      if (arrays.site_in_disc[v] && Number.isFinite(heights[v])) {
        minHeight = Math.min(minHeight, heights[v])
        maxHeight = Math.max(maxHeight, heights[v])
      }
    }
  }
  const faces = []
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const q = [i * n + j, i * n + j + 1, (i + 1) * n + j, (i + 1) * n + j + 1]
      if (!q.every(finite)) continue
      const closestX = Math.max(xyAxis[j], -xyAxis[j + 1], 0)
      const closestY = Math.max(xyAxis[i], -xyAxis[i + 1], 0)
      if (Math.hypot(closestX, closestY) > radius) continue
      faces.push(q[0], q[1], q[3], q[0], q[3], q[2])
    }
  }
  return {
    pos,
    xy,
    normals,
    heights,
    elevationRange: [minHeight, maxHeight],
    faces: Uint32Array.from(faces),
    radius,
  }
}

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Terrain shader: ${gl.getShaderInfoLog(sh)}`)
  return sh
}

const UNIFORMS = ['u_viewProj', 'u_width', 'u_radius', 'u_showElevation', 'u_elevationRange', 'u_elevationColors[0]']

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
  const vao = gl.createVertexArray()
  const buffers = []
  let geom = null

  function attribute(name, data, size) {
    const buf = gl.createBuffer()
    buffers.push(buf)
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    const at = gl.getAttribLocation(prog, name)
    gl.enableVertexAttribArray(at)
    gl.vertexAttribPointer(at, size, gl.FLOAT, false, 0, 0)
  }

  function setGeometry(g) {
    for (const b of buffers.splice(0)) gl.deleteBuffer(b)
    gl.bindVertexArray(vao)
    attribute('a_pos', g.pos, 3)
    attribute('a_xy', g.xy, 2)
    attribute('a_normal', g.normals, 3)
    attribute('a_height', g.heights, 1)
    const indexBuffer = gl.createBuffer()
    buffers.push(indexBuffer)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.faces, gl.STATIC_DRAW)
    gl.bindVertexArray(null)
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
    gl.bindVertexArray(vao)
    gl.drawElements(gl.TRIANGLES, geom.faces.length, gl.UNSIGNED_INT, 0)
    gl.bindVertexArray(null)
  }

  function dispose() {
    for (const b of buffers.splice(0)) gl.deleteBuffer(b)
    gl.deleteVertexArray(vao)
    gl.deleteProgram(prog)
  }

  return { setGeometry, draw, dispose }
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

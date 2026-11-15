import { ALBEDO_SRGB, LIGHTING_GLSL } from './lighting.js'
import { GRID_GLSL, GRID_UNIFORMS, gridUniforms } from './sequence.js'

const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_shade;
uniform sampler2D u_normal;   // east, north of the site-frame unit normal (float16)
uniform sampler2D u_horizon;
uniform vec2 u_size;
uniform vec2 u_centre;
uniform vec2 u_span;
uniform float u_bearingStep;
uniform bool u_realSun;       // false: the backend's fixed-light shade
uniform sampler2D u_distance; // ground distance of each pixel, m (float16)
uniform sampler2D u_seen;     // fraction of the Sun seen on the shadow grid at this step
uniform bool u_hasSeen;
out vec4 color;
${GRID_GLSL}
${LIGHTING_GLSL}
const float DEG = 0.017453292519943295;

// Texture coordinate of elevation angle "elevation" in raster column "column".
// Rows are packed towards the skyline: row = (1 - rel^(1/3)) (rows - 1),
// rel = (horizon - elevation) / (horizon + 90), as panorama.py writes them.
vec2 rasterUv(int column, float elevation, float horizon, ivec2 shape) {
  float relative = clamp((horizon - elevation) / max(horizon + 90.0, 1e-6), 0.0, 1.0);
  float row = (1.0 - pow(relative, 1.0 / 3.0)) * float(shape.y - 1);
  return (vec2(float(column), row) + 0.5) / vec2(shape);
}

// Fraction of the Sun seen at the ground point d metres along bearing a (radians).
// Shadow data covers the landing-site disc only; elsewhere 1 (slope lighting only).
float seenAt(float d, float a) {
  if (!u_hasSeen || d > u_gridFirst.w) return 1.0;
  return texture(u_seen, gridUv(d * vec2(sin(a), cos(a)))).r;
}

vec3 normalAt(vec2 uv) {
  vec2 en = texture(u_normal, uv).rg;
  return vec3(en, sqrt(max(0.0, 1.0 - dot(en, en))));
}

void main() {
  vec2 angle = u_centre + (gl_FragCoord.xy / u_size - 0.5) * u_span;
  float azimuth = mod(angle.x, 360.0);
  ivec2 shape = textureSize(u_shade, 0);
  int west = min(int(azimuth / u_bearingStep), shape.x - 1);
  int east = (west + 1) % shape.x;
  float interval = east == 0 ? 360.0 - float(west) * u_bearingStep : u_bearingStep;
  float blend = clamp((azimuth - float(west) * u_bearingStep) / interval, 0.0, 1.0);
  float westHorizon = texelFetch(u_horizon, ivec2(west, 0), 0).r;
  float eastHorizon = texelFetch(u_horizon, ivec2(east, 0), 0).r;
  float horizon = mix(westHorizon, eastHorizon, blend);
  float pixel = u_span.y / u_size.y;
  float ground = smoothstep(-pixel * 0.5, pixel * 0.5, horizon - angle.y);
  vec2 westUv = rasterUv(west, angle.y, westHorizon, shape);
  vec2 eastUv = rasterUv(east, angle.y, eastHorizon, shape);
  vec3 relief = vec3(mix(texture(u_shade, westUv).r, texture(u_shade, eastUv).r, blend));
  vec3 surface = relief;
  if (u_realSun) {
    vec3 n = normalize(mix(normalAt(westUv), normalAt(eastUv), blend));
    // The ray from the eye towards this pixel; the eye is at minus that direction.
    float a = azimuth * DEG;
    float e = angle.y * DEG;
    vec3 ray = vec3(cos(e) * sin(a), cos(e) * cos(a), sin(e));
    float d = mix(texture(u_distance, westUv).r, texture(u_distance, eastUv).r, blend);
    vec3 direct = sunDirect(n, -ray, vec3(${ALBEDO_SRGB.toFixed(3)}));
    surface = composeSunlit(relief, direct, seenAt(d, a));
  }
  // Premultiplied alpha: the sky stays transparent so the sky canvas beneath shows.
  color = vec4(ground * surface, ground);
}
`

/** Draw the cached angular raster with the matching horizon as its sky edge. */
export function createPanoramaRenderer(canvas, { header, arrays }) {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true })
  if (!gl) throw new Error('This browser needs WebGL2 to display the terrain panorama.')

  const program = gl.createProgram()
  const shaders = []
  const textures = []
  function dispose() {
    for (const shader of shaders) gl.deleteShader(shader)
    for (const texture of textures) gl.deleteTexture(texture)
    gl.deleteProgram(program)
  }
  function upload(unit, uniform, format, width, height, type, data, filter, layout = gl.RED) {
    const texture = gl.createTexture()
    textures.push(texture)
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, format, width, height, 0, layout, type, data)
    gl.uniform1i(gl.getUniformLocation(program, uniform), unit)
  }
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
      const shader = gl.createShader(type)
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader))
      gl.attachShader(program, shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
    gl.useProgram(program)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    const { columns, rows } = header.panorama
    upload(0, 'u_shade', gl.R8, columns, rows, gl.UNSIGNED_BYTE, arrays.panorama_shade, gl.LINEAR)
    upload(1, 'u_horizon', gl.R32F, columns, 1, gl.FLOAT, arrays.ray_skyline_deg, gl.NEAREST)
    // float16 bits as stored by the backend (half floats filter linearly in WebGL2).
    upload(2, 'u_normal', gl.RG16F, columns, rows, gl.HALF_FLOAT, arrays.panorama_normal, gl.LINEAR, gl.RG)
    upload(3, 'u_distance', gl.R16F, columns, rows, gl.HALF_FLOAT, arrays.panorama_distance_m, gl.LINEAR)
    upload(4, 'u_seen', gl.R8, 1, 1, gl.UNSIGNED_BYTE, new Uint8Array([255]), gl.LINEAR)
    const seenTexture = textures.at(-1)
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Could not upload the terrain panorama.')
    gl.uniform1f(gl.getUniformLocation(program, 'u_bearingStep'), header.skyline.azimuth_step_deg)
    const size = gl.getUniformLocation(program, 'u_size')
    const centre = gl.getUniformLocation(program, 'u_centre')
    const span = gl.getUniformLocation(program, 'u_span')
    const realSun = gl.getUniformLocation(program, 'u_realSun')
    const sun = gl.getUniformLocation(program, 'u_sun')
    const sunRadius = gl.getUniformLocation(program, 'u_sunRadius')
    const sunVisible = gl.getUniformLocation(program, 'u_sunVisible')
    const hasSeen = gl.getUniformLocation(program, 'u_hasSeen')
    const gridLoc = Object.fromEntries(GRID_UNIFORMS.map((u) => [u, gl.getUniformLocation(program, u)]))
    let seen = null
    return {
      /** Fraction of the Sun seen on the shadow grid (sequence.js seenAt) or null. */
      setSeen(next) {
        seen = next
        if (!next) return
        gl.activeTexture(gl.TEXTURE4)
        gl.bindTexture(gl.TEXTURE_2D, seenTexture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, next.nx, next.ny, 0, gl.RED, gl.UNSIGNED_BYTE, next.values)
      },
      draw({ heading, pitch, fov, width, height, lighting }) {
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.uniform1i(hasSeen, seen ? 1 : 0)
        if (seen) gridUniforms(gl, gridLoc, seen)
        const real = lighting?.mode === 'sun'
        gl.uniform1i(realSun, real ? 1 : 0)
        if (real) {
          gl.uniform3fv(sun, lighting.sun)
          gl.uniform1f(sunRadius, lighting.sunRadius)
          gl.uniform1f(sunVisible, lighting.sunVisible)
        }
        gl.uniform2f(size, canvas.width, canvas.height)
        gl.uniform2f(centre, heading, pitch)
        gl.uniform2f(span, fov, fov * height / width)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      },
      dispose,
    }
  } catch (error) {
    dispose()
    throw error
  }
}

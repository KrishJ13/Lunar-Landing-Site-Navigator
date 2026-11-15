import { ALBEDO_SRGB, LIGHTING_GLSL } from './lighting.js'
import { FIELD_GLSL, NEAR_GLSL, createShadowPass, fieldUniforms, uploadField } from './shadowField.js'

const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2DArray;
uniform sampler2D u_shade;
uniform sampler2D u_normal;   // east, north of the site-frame unit normal (float16)
uniform sampler2D u_horizon;
uniform vec2 u_size;
uniform vec2 u_centre;
uniform vec2 u_span;
uniform float u_bearingStep;
uniform bool u_realSun;       // false: the backend's fixed-light shade
uniform sampler2D u_seen;     // fraction of the Sun seen per raster cell at this step (shadow pass)
uniform bool u_hasSeen;
uniform bool u_hasNear;       // draw the ground near the eye from the finest height grid
uniform sampler2D u_nearSeen; // fraction of the Sun seen on the finest grid at this step
uniform bool u_hasNearSeen;
out vec4 color;
${LIGHTING_GLSL}
${FIELD_GLSL}
${NEAR_GLSL}
const float DEG = 0.017453292519943295;

// Texture coordinate of elevation angle "elevation" in raster column "column".
// Rows are packed towards the skyline: row = (1 - rel^(1/3)) (rows - 1),
// rel = (horizon - elevation) / (horizon + 90), as panorama.py writes them.
vec2 rasterUv(int column, float elevation, float horizon, ivec2 shape) {
  float relative = clamp((horizon - elevation) / max(horizon + 90.0, 1e-6), 0.0, 1.0);
  float row = (1.0 - pow(relative, 1.0 / 3.0)) * float(shape.y - 1);
  return (vec2(float(column), row) + 0.5) / vec2(shape);
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
    float seen = u_hasSeen ? mix(texture(u_seen, westUv).r, texture(u_seen, eastUv).r, blend) : 1.0;
    vec3 direct = sunDirect(n, -ray, vec3(${ALBEDO_SRGB.toFixed(3)}));
    surface = composeSunlit(relief, direct, seen);
  }
  // Near the eye, draw the ground the view ray actually meets on the finest grid
  // (1.5 m) rather than reading the panorama raster; cross-fade back to the
  // raster between 75 % and 95 % of that grid's reach.
  if (u_hasNear && ground > 0.0 && angle.y < 45.0) {
    float a = azimuth * DEG;
    float e = angle.y * DEG;
    vec3 v = vec3(cos(e) * sin(a), cos(e) * cos(a), sin(e));
    vec2 hit;
    if (nearHit(v, hit)) {
      float d = length(hit);
      vec2 slopes = nearSlopes(hit);
      vec3 near = vec3(nearRelief(slopes, d));
      if (u_realSun) {
        vec3 n = normalize(vec3(slopes, 1.0));
        float seen = u_hasNearSeen ? texture(u_nearSeen, (hit + u_level[0].x) / (2.0 * u_level[0].x)).r : 1.0;
        near = composeSunlit(near, sunDirect(n, -v, vec3(${ALBEDO_SRGB.toFixed(3)})), seen);
      }
      float w = 1.0 - smoothstep(0.75 * u_level[0].x, 0.95 * u_level[0].x, d);
      surface = mix(surface, near, w);
    }
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
  let shadows = null // { pass, field }: GPU shadows (setField)
  function dispose() {
    shadows?.pass.dispose()
    shadows?.nearPass.dispose()
    if (shadows) gl.deleteTexture(shadows.field.texture)
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
    // Ground distance of each raster cell, log-encoded uint16 (exact to 1e-4; read with texelFetch).
    gl.activeTexture(gl.TEXTURE3)
    const distanceTexture = gl.createTexture()
    textures.push(distanceTexture)
    gl.bindTexture(gl.TEXTURE_2D, distanceTexture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, columns, rows, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT,
      arrays.panorama_distance_log16)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    upload(4, 'u_seen', gl.R8, 1, 1, gl.UNSIGNED_BYTE, new Uint8Array([255]), gl.LINEAR)
    let seenTexture = textures.at(-1)
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
    let haveShadow = false
    // One texel per raster cell: its ground point is distance d along the column's bearing.
    const pointGlsl = `
uniform highp usampler2D u_distance16;
uniform float u_columnStep;          // degrees per raster column
uniform float u_logMax;              // ln(maximum distance, m)
bool groundPoint(ivec2 texel, out vec2 xy) {
  float d = exp(float(texelFetch(u_distance16, texel, 0).r) / 65535.0 * u_logMax);
  float a = float(texel.x) * u_columnStep * 0.017453292519943295;
  xy = d * vec2(sin(a), cos(a));
  return true;
}
`
    return {
      /** Height grids for GPU shadows (decoded POST /api/site/shadow-field), or null. */
      setField(next, lift = 0.5) {
        shadows?.pass.dispose()
        shadows?.nearPass.dispose()
        if (shadows) gl.deleteTexture(shadows.field.texture)
        shadows = null
        haveShadow = false
        if (!next) return
        const field = uploadField(gl, next, 5)
        const pass = createShadowPass(gl, field, columns, rows, pointGlsl, lift)
        const n0 = next.header.levels[0].size
        const nearPass = createShadowPass(gl, field, n0, n0, `
bool groundPoint(ivec2 texel, out vec2 xy) {
  xy = -u_level[0].x + (vec2(texel) + 0.5) * u_level[0].y;
  return true;
}
`, lift)
        shadows = { pass, nearPass, field }
      },
      /** Bake the fraction of the Sun seen per raster cell for Sun { dir (ENU unit), radius (rad) }. */
      setSun(sun) {
        haveShadow = false
        if (!shadows || !sun) return
        shadows.pass.run(sun, (p) => {
          gl.activeTexture(gl.TEXTURE3)
          gl.bindTexture(gl.TEXTURE_2D, distanceTexture)
          gl.uniform1i(gl.getUniformLocation(p, 'u_distance16'), 3)
          gl.uniform1f(gl.getUniformLocation(p, 'u_columnStep'), header.skyline.azimuth_step_deg)
          gl.uniform1f(gl.getUniformLocation(p, 'u_logMax'), Math.log(header.distance_log16_max_m))
        })
        shadows.nearPass.run(sun)
        seenTexture = shadows.pass.texture
        haveShadow = true
      },
      /** The baked shadow raster (debugging and tests), or null. */
      readShadow: () => (haveShadow ? shadows.pass.read() : null),
      draw({ heading, pitch, fov, width, height, lighting }) {
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.useProgram(program)
        gl.uniform1i(hasSeen, haveShadow ? 1 : 0)
        gl.activeTexture(gl.TEXTURE4)
        gl.bindTexture(gl.TEXTURE_2D, seenTexture)
        gl.uniform1i(gl.getUniformLocation(program, 'u_hasNear'), shadows ? 1 : 0)
        gl.uniform1i(gl.getUniformLocation(program, 'u_hasNearSeen'), haveShadow ? 1 : 0)
        if (shadows) {
          gl.activeTexture(gl.TEXTURE5)
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, shadows.field.texture)
          fieldUniforms(gl, program, shadows.field, { dir: [0, 0, 1], radius: 0.0047 })
          gl.uniform1f(gl.getUniformLocation(program, 'u_eyeH'), header.site.eye_m)
          gl.uniform1f(gl.getUniformLocation(program, 'u_dataCell'), header.panorama.foreground_pixel_m ?? 5)
          gl.activeTexture(gl.TEXTURE6)
          gl.bindTexture(gl.TEXTURE_2D, shadows.nearPass.texture)
          gl.uniform1i(gl.getUniformLocation(program, 'u_nearSeen'), 6)
        }
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

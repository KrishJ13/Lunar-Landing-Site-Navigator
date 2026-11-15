// GPU terrain shadows for Skyline V3. No React here.
//
// The backend sends nested height grids around the site (POST /api/site/shadow-field,
// backend/lunar/shadow_field.py, which also holds the reference ray march that this
// GLSL reproduces). For each ground point the shader marches the straight 3-D ray
// towards the Sun and records the smallest clearance angle above the terrain:
//   c = min over t of (h_ray(t) - h_terrain(t)) / t
// Visible fraction of a disc of angular radius r whose centre sits c above an edge:
//   f = 1 - (acos(u) - u sqrt(1 - u^2)) / pi,  u = clamp(c / r, -1, 1).
// Geometry is exact on the 1737.4 km sphere, in the site frame (origin the sphere
// centre, z the site's up), with float32-safe forms:
//   |Q|^2 - R^2 = (2R + h_P) h_P + 2 t (P . s) + t^2,   h_ray = X / (2R + X / 2R)
//   AE position of Q: theta = atan(|u_xy|, u_z) (acos would lose ~600 m near the site).
//
// The result is baked once per time step into a texture: the panorama raster
// (one texel per raster cell) or a square grid over the overhead disc.

export const FIELD_LEVELS = 5

export const FIELD_GLSL = `
const float MOON_R = 1737400.0;
uniform highp usampler2DArray u_field;   // uint16 heights, finest level first
uniform vec4 u_level[${FIELD_LEVELS}];    // half-width, spacing, lo, scale (m)
uniform float u_fieldTop;                // highest height in any level (m)
uniform float u_fieldReach;              // furthest ray length (m)
uniform vec3 u_sunDir;                   // unit, site ENU
uniform float u_sunRad;                  // Sun's angular radius (rad)

// Bilinear height (m) at AE point xy from the finest covering level; -1e9 where none.
float fieldHeight(vec2 xy, out float cell) {
  for (int i = 0; i < ${FIELD_LEVELS}; i++) {
    vec4 L = u_level[i];
    vec2 f = (xy + L.x) / L.y - 0.5;
    float last = 2.0 * L.x / L.y - 1.0;
    if (f.x >= 0.0 && f.y >= 0.0 && f.x <= last && f.y <= last) {
      ivec2 c0 = min(ivec2(floor(f)), ivec2(int(last) - 1));
      vec2 t = f - vec2(c0);
      uint q00 = texelFetch(u_field, ivec3(c0, i), 0).r;
      uint q01 = texelFetch(u_field, ivec3(c0 + ivec2(1, 0), i), 0).r;
      uint q10 = texelFetch(u_field, ivec3(c0 + ivec2(0, 1), i), 0).r;
      uint q11 = texelFetch(u_field, ivec3(c0 + ivec2(1, 1), i), 0).r;
      cell = L.y;
      if (q00 == 65535u || q01 == 65535u || q10 == 65535u || q11 == 65535u) return -1e9;
      float q = mix(mix(float(q00), float(q01), t.x), mix(float(q10), float(q11), t.x), t.y);
      return L.z + q * L.w;
    }
  }
  cell = 1e9;
  return -1e9;
}

vec3 aeUnit(vec2 xy) {
  float rho = length(xy);
  float th = rho / MOON_R;
  vec2 d = rho > 0.0 ? xy / rho : vec2(0.0, 1.0);
  return vec3(sin(th) * d, cos(th));
}

vec2 unitAe(vec3 u) {
  float s = length(u.xy);
  return s > 0.0 ? MOON_R * atan(s, u.z) * u.xy / s : vec2(0.0);
}

// Fraction of the Sun's disc visible from the ground point at AE xy, lift m above it.
float marchSeen(vec2 xy, float lift) {
  float cell;
  float h0 = fieldHeight(xy, cell);
  if (h0 < -1e8) return 1.0;
  h0 += lift;
  vec3 up = aeUnit(xy);
  float rp = MOON_R + h0;
  float ps = rp * dot(up, u_sunDir);
  float k0 = (2.0 * MOON_R + h0) * h0;
  float t = 1.5 * cell;
  float clear = 1e9;
  for (int i = 0; i < 900; i++) {
    float X = k0 + 2.0 * t * ps + t * t;
    float hr = X / (2.0 * MOON_R + X / (2.0 * MOON_R));
    float c2;
    float hg = fieldHeight(unitAe(normalize(rp * up + t * u_sunDir)), c2);
    clear = min(clear, (hr - hg) / t);
    if (clear < -u_sunRad || hr > u_fieldTop || t > u_fieldReach) break;
    t += max(c2, 0.02 * t);
  }
  float u = clamp(clear / u_sunRad, -1.0, 1.0);
  return 1.0 - (acos(u) - u * sqrt(1.0 - u * u)) / 3.141592653589793;
}
`

/** Upload the height grids (decoded shadow-field payload) as an R16UI 2D array texture. */
export function uploadField(gl, { header, arrays }, unit) {
  const size = header.size
  const texture = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2)
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R16UI, size, size, header.levels.length, 0,
    gl.RED_INTEGER, gl.UNSIGNED_SHORT, arrays.heights_q)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  const levels = new Float32Array(4 * FIELD_LEVELS)
  header.levels.forEach((L, i) => levels.set([L.half_m, L.spacing_m, L.lo_m, L.scale_m], 4 * i))
  const top = Math.max(...header.levels.map((L) => L.max_m))
  return { texture, unit, levels, top, reach: header.max_reach_m }
}

/** Set the field uniforms on `program` (the field texture must be bound to field.unit). */
export function fieldUniforms(gl, program, field, sun) {
  const at = (name) => gl.getUniformLocation(program, name)
  gl.uniform1i(at('u_field'), field.unit)
  gl.uniform4fv(at('u_level[0]'), field.levels)
  gl.uniform1f(at('u_fieldTop'), field.top)
  gl.uniform1f(at('u_fieldReach'), field.reach)
  gl.uniform3fv(at('u_sunDir'), sun.dir)
  gl.uniform1f(at('u_sunRad'), sun.radius)
}

const PASS_VERT = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`

/**
 * A pass that writes marchSeen for every texel of a width x height R8 texture.
 * `pointGlsl` defines `bool groundPoint(ivec2 texel, out vec2 xy)` (and any
 * uniforms it needs). Returns { texture, run(sun, setExtra), dispose }.
 */
export function createShadowPass(gl, field, width, height, pointGlsl, lift = 0.5) {
  const frag = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2DArray;
${FIELD_GLSL}
${pointGlsl}
out vec4 o;
void main() {
  vec2 xy;
  float seen = groundPoint(ivec2(gl_FragCoord.xy), xy) ? marchSeen(xy, ${lift.toFixed(2)}) : 1.0;
  o = vec4(seen, 0.0, 0.0, 1.0);
}
`
  const program = link(gl, PASS_VERT, frag)
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, null)
  const framebuffer = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return {
    texture,
    run(sun, setExtra) {
      const viewport = gl.getParameter(gl.VIEWPORT)
      const previous = gl.getParameter(gl.CURRENT_PROGRAM)
      gl.useProgram(program)
      gl.activeTexture(gl.TEXTURE0 + field.unit)
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, field.texture)
      fieldUniforms(gl, program, field, sun)
      setExtra?.(program)
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.viewport(0, 0, width, height)
      gl.disable(gl.DEPTH_TEST)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(...viewport)
      gl.useProgram(previous)
    },
    /** Read back the result (debugging and tests): Uint8Array width * height * 4. */
    read() {
      const out = new Uint8Array(width * height * 4)
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return out
    },
    dispose() {
      gl.deleteFramebuffer(framebuffer)
      gl.deleteTexture(texture)
      gl.deleteProgram(program)
    },
  }
}

function link(gl, vs, fs) {
  const program = gl.createProgram()
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Shadow shader: ${gl.getShaderInfoLog(shader)}`)
    gl.attachShader(program, shader)
    gl.deleteShader(shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Shadow shader: ${gl.getProgramInfoLog(program)}`)
  return program
}

/**
 * GLSL for drawing the ground near the eye straight from the finest height grid
 * (level 0) instead of the pre-rendered panorama. Needs FIELD_GLSL, plus
 * uniforms u_eyeH (eye height above the sphere, m) and u_dataCell (the source
 * map's cell, m: slopes are taken over one cell, as backend/lunar/panorama.py).
 *
 * nearHit: march the view ray from the eye; the eye is at site-frame
 * (0, 0, R + eyeH), the ray E + t v. Its height above the sphere is
 *   X = (2R + eyeH) eyeH + 2 t (R + eyeH) v_z + t^2,  h = X / (2R + X / 2R)
 * and its ground position (AE) is R atan(t |v_xy|, R + eyeH + t v_z) v_xy / |v_xy|
 * (small and large terms kept apart for float32). The first step where the ray
 * drops below the terrain is refined linearly between the last two samples.
 *
 * nearRelief: the backend's fixed-light shading (panorama.py _shade_from_slopes and
 * _shade_pixels), so the hand-over to the panorama is seamless:
 *   e = -dh/dx, n = -dh/dy,  c = (-0.72 e + 0.60 n + 0.34) / sqrt(1 + e^2 + n^2)
 *   shade = 0.47 + 0.42 tanh((c - 0.34) / 0.2),  x (0.55 + 0.45 clamp(ln(1+d) / ln(1+15000)))
 */
export const NEAR_GLSL = `
uniform float u_eyeH;
uniform float u_dataCell;

float nearHeight(vec2 xy) {
  vec4 L = u_level[0];
  float last = 2.0 * L.x / L.y - 1.0;
  vec2 f = clamp((xy + L.x) / L.y - 0.5, vec2(0.0), vec2(last - 0.001));
  ivec2 c0 = ivec2(floor(f));
  vec2 t = f - vec2(c0);
  float q00 = float(texelFetch(u_field, ivec3(c0, 0), 0).r);
  float q01 = float(texelFetch(u_field, ivec3(c0 + ivec2(1, 0), 0), 0).r);
  float q10 = float(texelFetch(u_field, ivec3(c0 + ivec2(0, 1), 0), 0).r);
  float q11 = float(texelFetch(u_field, ivec3(c0 + ivec2(1, 1), 0), 0).r);
  return L.z + mix(mix(q00, q01, t.x), mix(q10, q11, t.x), t.y) * L.w;
}

vec2 rayGround(vec3 v, float t) {
  float s = length(v.xy);
  if (s < 1e-6) return vec2(0.0);
  return MOON_R * atan(t * s, MOON_R + u_eyeH + t * v.z) * v.xy / s;
}

// First ground hit of the view ray v (unit, site ENU) within the finest grid.
bool nearHit(vec3 v, out vec2 hitXy) {
  float reach = u_level[0].x * 0.97;
  float k0 = (2.0 * MOON_R + u_eyeH) * u_eyeH;
  float tPrev = 0.0;
  float dPrev = u_eyeH - nearHeight(vec2(0.0));
  float t = 0.3;
  for (int i = 0; i < 480; i++) {
    float X = k0 + 2.0 * t * (MOON_R + u_eyeH) * v.z + t * t;
    float hr = X / (2.0 * MOON_R + X / (2.0 * MOON_R));
    vec2 xy = rayGround(v, t);
    if (length(xy) > reach) return false;
    float dz = hr - nearHeight(xy);
    if (dz <= 0.0) {
      float f = dPrev / max(dPrev - dz, 1e-6);
      hitXy = rayGround(v, mix(tPrev, t, f));
      return true;
    }
    if (v.z > 0.0 && hr > u_fieldTop) return false;
    tPrev = t;
    dPrev = dz;
    t += max(0.4, 0.012 * t);
  }
  return false;
}

// East and north slopes (-dh/dx, -dh/dy) over one source-map cell.
vec2 nearSlopes(vec2 xy) {
  float h = max(u_dataCell, u_level[0].y) * 0.5;
  float dx = (nearHeight(xy + vec2(h, 0.0)) - nearHeight(xy - vec2(h, 0.0))) / (2.0 * h);
  float dy = (nearHeight(xy + vec2(0.0, h)) - nearHeight(xy - vec2(0.0, h))) / (2.0 * h);
  return vec2(-dx, -dy);
}

float nearRelief(vec2 slopes, float distance) {
  float c = (-0.72 * slopes.x + 0.60 * slopes.y + 0.34) / sqrt(1.0 + dot(slopes, slopes));
  float shade = 0.47 + 0.42 * tanh((c - 0.34) / 0.20);
  float depth = clamp(log(1.0 + distance) / log(1.0 + 15000.0), 0.0, 1.0);
  return clamp(shade * (0.55 + 0.45 * depth), 0.0, 1.0);
}
`

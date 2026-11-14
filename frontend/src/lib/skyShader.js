// WebGL2 sky behind the terrain: star field, Sun and Earth.
// No React here. createSkyRenderer(canvas) returns { render(params), dispose() },
// or null when WebGL2 is unavailable (the caller then falls back to flat discs).
//
// Projection: the same cylindrical mapping as lib/view.js makeViewScale, so
// every pixel's (azimuth, elevation) matches the terrain canvas drawn on top:
//   az = heading + (x - W/2) / pxPerDeg        el = pitch + (y - H/2) / pxPerDeg
// (x, y in device pixels, y measured up from the bottom edge.)
// The terrain canvas is opaque wherever there is ground, so it is the horizon
// cut-off: nothing below the skyline needs to be masked here.
//
// Discs are drawn round on screen with their exact angular radius
// rho_deg = sqrt(dAz^2 + dEl^2) <= r, using screen degrees (dAz is not scaled
// by cos el). The cylindrical projection would instead stretch a disc
// horizontally by 1/cos(el): under 1.5 % within 10 deg of the horizon, where
// the terrain cut-off happens, and a visibly wide ellipse high in the sky.
// lib/view.js bodyVisibility() integrates over the same round disc.

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`

const FRAG = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;

uniform vec2 u_res;        // device pixels
uniform float u_dpr;
uniform float u_heading;   // deg
uniform float u_pitch;     // deg
uniform float u_ppd;       // device pixels per degree

uniform vec3 u_sun;        // az deg, el deg, angular radius deg
uniform float u_sunVis;    // visible fraction of the disc above the terrain, 0..1
uniform vec3 u_earth;      // az deg, el deg, angular radius deg
uniform float u_earthVis;
uniform mat3 u_earthBasis; // columns: screen-right, screen-up, toward observer (ENU)
uniform vec3 u_earthLight; // unit vector from Earth to Sun (ENU)
uniform float u_starGain;  // star brightness multiplier (exposure)
uniform int u_hasBodies;

const float PI = 3.141592653589793;
const float DEG = PI / 180.0;

// Signed a - b wrapped into (-180, 180].
float wrapDiff(float a, float b) {
  float d = mod(a - b, 360.0);
  return d > 180.0 ? d - 360.0 : d;
}

// PCG-style hash (Jarzynski & Olano 2020), 4 outputs in [0, 1).
uvec4 pcg4d(uvec4 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v ^= v >> 16u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return v;
}
vec4 hash4(ivec3 p, int seed) {
  return vec4(pcg4d(uvec4(uvec3(p + 32768), uint(seed)))) / 4294967296.0;
}

// --- stars -----------------------------------------------------------------
// Sky split into elevation bands of 'cell' degrees; each band into roughly
// equal-area azimuth cells (360 cos(el) / cell of them). At most one star per
// cell, placed at a hashed spot; the 3x3 neighbouring cells are checked so
// stars are never cut at cell edges. Stars are points (a fixed ~1 px Gaussian)
// at every field of view. No twinkle: the Moon has no atmosphere.
// Phase 1: the field is fixed to the local horizon frame, not the celestial
// sphere, so it does not turn with time.
vec3 starLayer(float az, float el, float cell, float density, float gain, int seed) {
  vec3 acc = vec3(0.0);
  int bands = int(180.0 / cell);
  int j0 = int(floor((el + 90.0) / cell));
  float sigma = 0.55 * u_dpr;
  for (int dj = -1; dj <= 1; dj++) {
    int j = j0 + dj;
    if (j < 0 || j >= bands) continue;
    float elc = -90.0 + (float(j) + 0.5) * cell;
    int n = max(1, int(floor(360.0 * cos(elc * DEG) / cell)));
    float w = 360.0 / float(n);
    int i0 = int(floor(mod(az, 360.0) / w));
    for (int di = -1; di <= 1; di++) {
      int i = (i0 + di + n) % n;
      vec4 h = hash4(ivec3(i, j, 0), seed);
      if (h.x > density) continue;
      float saz = (float(i) + h.y) * w;
      float sel = -90.0 + (float(j) + h.z) * cell;
      vec2 d = vec2(wrapDiff(az, saz), el - sel) * u_ppd;
      float flux = pow(h.w, 7.0); // many faint stars, few bright ones
      float core = exp(-dot(d, d) / (2.0 * sigma * sigma));
      // colour: hashed temperature from orange-ish to blue-white
      float t = fract(h.y * 7.31 + h.z * 3.17);
      vec3 tint = mix(vec3(1.0, 0.82, 0.62), vec3(0.75, 0.85, 1.0), t);
      acc += tint * flux * core * gain;
    }
  }
  return acc;
}

// --- value noise for Earth's clouds ---------------------------------------
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  ivec3 b = ivec3(i);
  float n000 = hash4(b, 7).x, n100 = hash4(b + ivec3(1, 0, 0), 7).x;
  float n010 = hash4(b + ivec3(0, 1, 0), 7).x, n110 = hash4(b + ivec3(1, 1, 0), 7).x;
  float n001 = hash4(b + ivec3(0, 0, 1), 7).x, n101 = hash4(b + ivec3(1, 0, 1), 7).x;
  float n011 = hash4(b + ivec3(0, 1, 1), 7).x, n111 = hash4(b + ivec3(1, 1, 1), 7).x;
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int k = 0; k < 5; k++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s;
}

// --- Sun ---------------------------------------------------------------------
// Disc: linear limb darkening I(mu) = 1 - u (1 - mu), u = 0.6 (visible light),
// mu = sqrt(1 - (rho/r)^2). Glow: an artistic lens bloom (there is no air to
// scatter light on the Moon), scaled by the disc's visible fraction so a Sun
// fully behind a ridge does not glow over it.
vec3 sun(float az, float el) {
  vec2 dd = vec2(wrapDiff(az, u_sun.x), el - u_sun.y);
  float rhoPx = length(dd) * u_ppd;
  float rPx = u_sun.z * u_ppd;
  vec3 white = vec3(1.0, 0.97, 0.92);
  float x = clamp(rhoPx / max(rPx, 1e-3), 0.0, 1.0);
  float mu = sqrt(1.0 - x * x);
  float limb = 1.0 - 0.6 * (1.0 - mu);
  float cover = clamp(rPx + 0.5 - rhoPx, 0.0, 1.0); // anti-aliased edge
  // Disc kept below saturation (after the tone map) so the limb darkening shows.
  vec3 c = white * limb * cover * 2.2;

  // Bloom lives mostly in screen pixels (it is a camera effect), growing only
  // a little with the disc so a zoomed-in Sun is not swamped.
  float rr = max(rPx, 2.0 * u_dpr);
  float out_ = max(rhoPx - rPx, 0.0);
  float halo = 0.9 * exp(-out_ / (4.0 * u_dpr + 0.12 * rr))
             + 0.22 * exp(-out_ / (22.0 * u_dpr + 0.4 * rr))
             + 0.05 * exp(-out_ / (110.0 * u_dpr));
  float ang = atan(dd.y, dd.x);
  float rays = pow(abs(cos(3.0 * ang)), 160.0) * exp(-out_ / (35.0 * u_dpr + 0.3 * rr)) * 0.2;
  c += vec3(1.0, 0.92, 0.80) * (halo + rays) * u_sunVis;
  return c;
}

// --- Earth -------------------------------------------------------------------
// Lit by the true Sun direction (u_earthLight = normalize(S - E)), so the phase
// is exact for the date. Surface is a placeholder: deep ocean with procedural
// clouds and a thin blue limb; continents need Earth's orientation (phase 2).
vec4 earth(float az, float el) {
  vec2 dd = vec2(wrapDiff(az, u_earth.x), el - u_earth.y);
  float rPx = u_earth.z * u_ppd;
  float rhoPx = length(dd) * u_ppd;
  float cover = clamp(rPx + 0.5 - rhoPx, 0.0, 1.0);

  // faint atmosphere rim just outside the disc, sunlit side only
  float outside = max(rhoPx - rPx, 0.0);
  vec2 q = dd / max(u_earth.z, 1e-6);
  float qq = min(dot(q, q), 1.0);
  vec3 nEdge = u_earthBasis * vec3(q / sqrt(max(dot(q, q), 1e-9)), 0.0);
  float litEdge = clamp(dot(nEdge, u_earthLight) * 1.5 + 0.2, 0.0, 1.0);
  vec3 glow = vec3(0.35, 0.6, 1.0) * exp(-outside / (0.06 * rPx + 0.8 * u_dpr)) * 0.35 * litEdge * u_earthVis;
  if (cover <= 0.0) return vec4(glow, 0.0);
  glow *= 1.0 - cover; // rim glow belongs outside the disc only

  vec3 nLocal = vec3(q, sqrt(1.0 - qq));
  vec3 N = u_earthBasis * nLocal;           // surface normal in ENU
  vec3 L = u_earthLight;
  float ndl = dot(N, L);
  float day = smoothstep(-0.04, 0.12, ndl);  // soft terminator

  float cl = fbm(N * 3.2 + vec3(1.7, 4.1, 2.3));
  float clouds = smoothstep(0.48, 0.72, cl);
  vec3 ocean = vec3(0.02, 0.09, 0.26);
  vec3 surf = mix(ocean, vec3(0.93), clouds);
  float lambert = max(ndl, 0.0);

  // Sun glint on open ocean: V = toward observer = basis column 3.
  vec3 V = u_earthBasis[2];
  vec3 H = normalize(L + V);
  float glint = pow(max(dot(N, H), 0.0), 140.0) * (1.0 - clouds) * 0.3;

  float rim = pow(1.0 - nLocal.z, 3.0);
  vec3 col = surf * (0.08 + 1.1 * lambert) * day + glint * day + vec3(0.3, 0.55, 1.0) * rim * 0.5 * day;
  col += vec3(0.0006, 0.0008, 0.0014); // night side just off black so the disc edge reads (display choice)
  return vec4(col * 1.4 + glow, cover);
}

void main() {
  vec2 p = gl_FragCoord.xy;
  float az = u_heading + (p.x - 0.5 * u_res.x) / u_ppd;
  float el = u_pitch + (p.y - 0.5 * u_res.y) / u_ppd;

  vec3 sky = vec3(0.0);
  sky += starLayer(az, el, 1.3, 0.5, 2.2, 1);
  sky += starLayer(az, el, 0.5, 0.35, 0.45, 2);
  sky *= u_starGain;

  vec3 col = sky;
  if (u_hasBodies == 1) {
    vec4 e = earth(az, el);
    // On the disc: cover the stars. Outside it: e.rgb is the faint rim glow, added.
    col = e.a > 0.0 ? mix(col, e.rgb, e.a) : col + e.rgb;
    col += sun(az, el);
  }
  // filmic-ish tone map, then gamma
  col = 1.0 - exp(-col);
  outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`

const UNIFORMS = [
  'u_res', 'u_dpr', 'u_heading', 'u_pitch', 'u_ppd',
  'u_sun', 'u_sunVis', 'u_earth', 'u_earthVis', 'u_earthBasis', 'u_earthLight',
  'u_starGain', 'u_hasBodies',
]

function compile(gl, type, src) {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s)
    gl.deleteShader(s)
    throw new Error(`Sky shader failed to compile: ${log}`)
  }
  return s
}

const rad = (d) => (d * Math.PI) / 180

/** Unit ENU vector (east, north, up) for azimuth/elevation in degrees. */
export function enuVector(azDeg, elDeg) {
  const a = rad(azDeg)
  const e = rad(elDeg)
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)]
}

/**
 * Columns of the Earth disc's local frame in ENU: screen-right (increasing
 * azimuth), screen-up (increasing elevation), toward the observer (-b).
 * Column-major Float32Array for uniformMatrix3fv.
 */
export function earthBasis(azDeg, elDeg) {
  const a = rad(azDeg)
  const e = rad(elDeg)
  const right = [Math.cos(a), -Math.sin(a), 0]
  const up = [-Math.sin(a) * Math.sin(e), -Math.cos(a) * Math.sin(e), Math.cos(e)]
  const b = enuVector(azDeg, elDeg)
  return new Float32Array([...right, ...up, -b[0], -b[1], -b[2]])
}

/** Unit vector from Earth to Sun: normalize(dS * s_hat - dE * e_hat), all from the observer. */
export function earthToSun(sun, earth) {
  const s = enuVector(sun.azimuth_deg, sun.elevation_deg).map((v) => v * sun.distance_km)
  const e = enuVector(earth.azimuth_deg, earth.elevation_deg).map((v) => v * earth.distance_km)
  const d = [s[0] - e[0], s[1] - e[1], s[2] - e[2]]
  const n = Math.hypot(...d)
  return d.map((v) => v / n)
}

export function createSkyRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false })
  if (!gl) return null
  const prog = gl.createProgram()
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Sky shader failed to link: ${gl.getProgramInfoLog(prog)}`)
  const loc = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)]))

  // One triangle covering the viewport.
  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  /**
   * params: { heading, pitch, pxPerDeg (CSS px), dpr, bodies ({sun, earth} or null),
   *           visibility ({sun, earth} visible fractions) }
   */
  function render({ heading, pitch, pxPerDeg, dpr, bodies, visibility }) {
    const W = canvas.width
    const H = canvas.height
    gl.viewport(0, 0, W, H)
    gl.useProgram(prog)
    gl.bindVertexArray(vao)
    gl.uniform2f(loc.u_res, W, H)
    gl.uniform1f(loc.u_dpr, dpr)
    gl.uniform1f(loc.u_heading, heading)
    gl.uniform1f(loc.u_pitch, pitch)
    gl.uniform1f(loc.u_ppd, pxPerDeg * dpr)
    const sunVis = bodies ? visibility?.sun ?? 1 : 0
    // Exposure: stars fade to 30 % while any of the Sun is above the skyline
    // (a camera exposed for the sunlit ground would show almost none).
    gl.uniform1f(loc.u_starGain, 1 - 0.7 * Math.min(sunVis * 4, 1))
    gl.uniform1i(loc.u_hasBodies, bodies ? 1 : 0)
    if (bodies) {
      const { sun, earth } = bodies
      gl.uniform3f(loc.u_sun, sun.azimuth_deg, sun.elevation_deg, sun.angular_radius_deg)
      gl.uniform1f(loc.u_sunVis, sunVis)
      gl.uniform3f(loc.u_earth, earth.azimuth_deg, earth.elevation_deg, earth.angular_radius_deg)
      gl.uniform1f(loc.u_earthVis, visibility?.earth ?? 1)
      gl.uniformMatrix3fv(loc.u_earthBasis, false, earthBasis(earth.azimuth_deg, earth.elevation_deg))
      gl.uniform3fv(loc.u_earthLight, earthToSun(sun, earth))
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  function dispose() {
    gl.deleteBuffer(buf)
    gl.deleteVertexArray(vao)
    gl.deleteProgram(prog)
    // Do not force-lose the context: the same canvas keeps it, and React
    // StrictMode remounts effects on that canvas right after a dispose.
  }

  return { render, dispose }
}

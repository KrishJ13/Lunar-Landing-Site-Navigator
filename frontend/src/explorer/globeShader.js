import { MOON_RADIUS_KM, POLAR_LIMIT, discRadius } from './geometry.js'
import { EQ, NORTH, NORTH_NAC, SOUTH_NAC, NAC_POLAR_MIN, POLAR_ORIGIN_M, TABLE_SIDE, WAC_POLAR_MIN, createTrekMaps } from './trekMaps.js'

export const MAP_DIRECTORY = `${import.meta.env.BASE_URL}moon/`

const vertexSource = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`

const fragmentSource = `#version 300 es
precision highp float;
precision highp int;
out vec4 color;

uniform vec2 resolution;
uniform float disc;
uniform float distanceToCamera;
uniform float polarLimit;
uniform mat3 camera;
uniform vec3 sun;
uniform vec3 shadowEarth;
uniform vec3 earth;
uniform bool showCoverage;
uniform vec3 selectedPoints[2];
uniform vec2 selectionDiametersKm;
uniform sampler2D albedo;
uniform highp sampler2DArray trekAtlas;
uniform highp isampler2D trekIndex;
uniform ivec3 trekLevels;
uniform sampler2D globalDem;
uniform sampler2D northDem;
uniform sampler2D southDem;
uniform vec2 globalOffset, globalScale, globalCenter;
uniform float globalWest;
uniform vec2 northOffset, northScale, southOffset, southScale;

const float PI = 3.141592653589793;
const float RADIUS = ${MOON_RADIUS_KM};

vec2 longitudeLatitude(vec3 p) {
  float longitude = abs(p.x) + abs(p.y) < 1e-7 ? 0.0 : atan(p.y, p.x);
  return vec2(longitude, atan(p.z, length(p.xy)));
}

vec2 tileDetail(vec2 uv, int level, int minimum, int firstBand, bool wraps, bool polar) {
  for (int parent = 0; parent <= 2; parent++) {
    int z = level - parent;
    if (z < minimum) break;
    int n = 1 << z;
    int columns = polar ? n : 2 * n;
    vec2 grid = uv * vec2(columns, n);
    ivec2 cell = ivec2(floor(grid));
    int col = wraps ? (cell.x + columns) % columns : cell.x;
    if (col < 0 || col >= columns || cell.y < 0 || cell.y >= n) continue;
    int band = firstBand + z - minimum;
    ivec4 entry = texelFetch(trekIndex, ivec2(col % ${TABLE_SIDE}, band * ${TABLE_SIDE} + cell.y % ${TABLE_SIDE}), 0);
    if (entry.z == 0 || entry.x != col || entry.y != cell.y) continue;
    vec3 address = vec3(fract(grid), float(entry.z - 1));
    vec4 sharp = textureLod(trekAtlas, address, 0.0);
    vec4 smoothTile = textureLod(trekAtlas, address, 3.0);
    float coverage = sharp.a;
    if (polar) coverage *= smoothstep(0.005, 0.045, smoothTile.r);
    if (coverage < 0.01) continue;
    float residual = clamp((sharp.r + 0.06) / (smoothTile.r + 0.06), 0.33, 2.7);
    return vec2(residual, coverage);
  }
  return vec2(1.0, 0.0);
}

float trekDetail(vec3 p, vec2 uv, float latitude) {
  vec2 equatorial = tileDetail(uv, trekLevels.x, ${EQ.minLevel}, ${EQ.firstRow}, true, false);
  float detail = mix(1.0, equatorial.x, equatorial.y);
  if (latitude >= ${WAC_POLAR_MIN}.0) {
    float scale = 1000.0 * RADIUS / (${POLAR_ORIGIN_M}.0 * (1.0 + abs(p.z)));
    vec2 polarUv = vec2(p.y, sign(p.z) * p.x) * scale + 0.5;
    vec2 regional = tileDetail(polarUv, trekLevels.y, ${NORTH.minLevel}, ${NORTH.firstRow}, false, true);
    float poleWeight = smoothstep(60.0, 69.0, latitude);
    if (trekLevels.x >= 7) poleWeight *= mix(0.16, 1.0, smoothstep(80.0, 86.0, latitude));
    detail = mix(detail, regional.x, regional.y * poleWeight);
    if (latitude >= ${NAC_POLAR_MIN}) {
      vec2 closeup = tileDetail(polarUv, trekLevels.z, ${NORTH_NAC.minLevel}, p.z > 0.0 ? ${NORTH_NAC.firstRow} : ${SOUTH_NAC.firstRow}, false, true);
      detail = mix(detail, closeup.x, closeup.y * smoothstep(${NAC_POLAR_MIN}, 85.7, latitude));
    }
  }
  return detail;
}

float readHeight(sampler2D map, vec2 uv) {
  // The two bytes form a linear height value, so texture filtering also
  // interpolates the decoded result. Values are kilometres above the sphere.
  vec2 bytes = textureLod(map, uv, 0.0).rg * 255.0;
  return (dot(bytes, vec2(256.0, 1.0)) * 0.5 - 12000.0) / 1000.0;
}

float terrain(vec3 p) {
  vec2 lonLat = longitudeLatitude(p);
  vec2 degreesLL = degrees(lonLat);
  degreesLL.x = globalWest + mod(degreesLL.x - globalWest, 360.0);
  float base = readHeight(globalDem, globalOffset + (degreesLL - globalCenter) * globalScale);
  float latitude = abs(degreesLL.y);
  if (latitude <= 75.0) return base;
  float r = 2000.0 * RADIUS * tan((PI * 0.5 - abs(lonLat.y)) * 0.5);
  vec2 polar = r * vec2(sin(lonLat.x), sign(p.z) * cos(lonLat.x));
  float cap = p.z > 0.0
    ? readHeight(northDem, northOffset + polar * northScale)
    : readHeight(southDem, southOffset + polar * southScale);
  return mix(base, cap, smoothstep(75.0, 77.0, latitude));
}

vec3 displaced(vec3 p) {
  return p * (RADIUS + terrain(p));
}

vec3 normalAt(vec3 p) {
  vec3 east = length(p.xy) > 1e-6 ? normalize(vec3(-p.y, p.x, 0.0)) : vec3(0.0, 1.0, 0.0);
  vec3 north = cross(p, east);
  float stepSize = mix(0.001, 0.00026, smoothstep(75.0, 77.0, abs(degrees(asin(p.z)))));
  vec3 dx = displaced(normalize(p + east * stepSize)) - displaced(normalize(p - east * stepSize));
  vec3 dy = displaced(normalize(p + north * stepSize)) - displaced(normalize(p - north * stepSize));
  return normalize(cross(dx, dy));
}

float hillShadow(vec3 p, vec3 light, float sunRadius) {
  vec3 origin = displaced(p);
  float blockingAngle = -0.5;
  float sampleDistance = abs(p.z) > polarLimit ? 0.44 : 2.15;
  for (int step = 0; step < 27; ++step) {
    vec3 ray = origin + light * sampleDistance;
    float clearance = length(ray) - RADIUS - terrain(normalize(ray));
    blockingAngle = max(blockingAngle, -clearance / sampleDistance);
    sampleDistance *= 1.24;
  }
  return 1.0 - smoothstep(-sunRadius, sunRadius, blockingAngle);
}

float eclipse(vec3 point, vec3 light, float sunRadius) {
  vec3 toEarth = shadowEarth - point;
  vec3 earthDirection = normalize(toEarth);
  if (dot(light, earthDirection) < 0.999) return 1.0;
  float earthRadius = asin(6371.0 / length(toEarth));
  float separation = atan(length(cross(light, earthDirection)), dot(light, earthDirection));
  if (separation >= earthRadius + sunRadius) return 1.0;
  if (separation <= earthRadius - sunRadius) return 0.0;
  float d = separation / sunRadius;
  float r = earthRadius / sunRadius;
  float a = (d*d + 1.0 - r*r) / (2.0*d);
  float b = (d*d + r*r - 1.0) / (2.0*d*r);
  float overlap = acos(clamp(a, -1.0, 1.0)) + r*r*acos(clamp(b, -1.0, 1.0))
    - d*sqrt(max(0.0, 1.0 - a*a));
  return clamp(1.0 - overlap / PI, 0.0, 1.0);
}

float siteRing(vec3 point, vec3 centre, float diameter) {
  float distance = length(point - centre);
  // At the limb derivatives can include a neighbouring ray that missed the sphere.
  float edge = clamp(fwidth(distance), 1e-7, 3.0 / disc);
  float radius = 2.0 * sin(diameter / (4.0 * RADIUS));
  return step(0.5, dot(centre, centre))
    * (1.0 - smoothstep(0.45, 1.3, abs(distance - radius) / edge));
}

void main() {
  vec2 offset = (gl_FragCoord.xy - resolution * 0.5) / disc;
  float r2 = dot(offset, offset);
  float root = sqrt(max(0.0, 1.0 - r2));
  float d = distanceToCamera;
  vec3 p = normalize(camera * vec3(offset * sqrt(d*d - 1.0), 1.0 + d * root));
  vec2 uv = longitudeLatitude(p) / vec2(2.0 * PI, -PI) + 0.5;
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  dx.x -= round(dx.x);
  dy.x -= round(dy.x);
  // The union of the same three regions used by pointer picking.
  float coverage = max(max(p.x, dot(p, earth)), abs(p.z) - polarLimit);
  float coverageEdge = max(1e-7, fwidth(coverage));
  float firstSite = siteRing(p, selectedPoints[0], selectionDiametersKm.x);
  float secondSite = siteRing(p, selectedPoints[1], selectionDiametersKm.y);
  if (r2 > 1.0) {
    color = vec4(0.0);
    return;
  }

  vec3 reflectance = textureGrad(albedo, uv, dx, dy).rgb;
  float imageDetail = trekDetail(p, uv, abs(180.0 * (0.5 - uv.y)));
  reflectance *= pow(imageDetail, 0.83);
  vec3 point = p * RADIUS;
  vec3 toSun = sun - point;
  vec3 light = normalize(toSun);
  vec3 view = normalize(camera[2] * d - p);
  float sunRadius = asin(695700.0 / length(toSun));
  float incidence = dot(light, p);
  float visibleSun = 0.0;
  float scattering = 0.0;
  if (incidence > -0.13) {
    vec3 n = normalAt(p);
    if (incidence < 0.17) {
      visibleSun = hillShadow(p, light, sunRadius);
    } else {
      visibleSun = 1.0;
    }
    float mu0 = max(0.0, dot(n, light));
    float mu = max(0.0, dot(n, view));
    // A Lommel-Seeliger term models an airless, particulate surface.
    scattering = mix(2.0 * mu0 / max(0.001, mu0 + mu), mu0, 0.19);
    visibleSun *= eclipse(point, light, sunRadius);
  }

  vec3 linear = pow(reflectance, vec3(2.2));
  vec3 direct = linear * (2.3 * scattering * visibleSun);
  // Low neutral fill keeps the edge and selectable shadowed terrain legible.
  vec3 ambient = vec3(0.0012) + 0.009 * linear;
  vec3 image = pow(clamp(direct + ambient, 0.0, 1.0), vec3(1.0 / 2.2));
  if (showCoverage && coverage >= 0.0) {
    const vec3 tint = vec3(0.33, 0.86, 0.81);
    float boundary = 1.0 - smoothstep(0.0, 1.4 * coverageEdge, coverage);
    image = mix(image, tint, mix(0.22, 0.83, boundary));
  }
  image = mix(image, vec3(1.0, 0.84, 0.42), firstSite);
  image = mix(image, vec3(0.52, 0.91, 0.68), secondSite);
  color = vec4(image, 1.0);
}
`

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  const error = gl.getShaderInfoLog(shader)
  gl.deleteShader(shader)
  throw new Error(error)
}

function link(gl) {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
  let fragment
  const program = gl.createProgram()
  try {
    fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program
    throw new Error(gl.getProgramInfoLog(program))
  } catch (error) {
    gl.deleteProgram(program)
    throw error
  } finally {
    gl.deleteShader(vertex)
    if (fragment) gl.deleteShader(fragment)
  }
}

async function loadImage(name, signal) {
  const response = await fetch(`${MAP_DIRECTORY}${name}.webp`, { signal })
  if (!response.ok) throw new Error(`Unable to load ${name} lunar texture`)
  return createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' })
}

export async function loadGlobe(canvas, signal, requestRedraw) {
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false })
  if (!gl) throw new Error('This browser needs WebGL 2 to render the Moon.')
  const program = link(gl)
  gl.useProgram(program)
  const uniform = (name) => gl.getUniformLocation(program, name)
  const textures = []
  let trek
  const cleanup = () => {
    trek?.dispose()
    for (const texture of textures) gl.deleteTexture(texture)
    gl.deleteProgram(program)
  }

  async function upload(name, index, isColor) {
    const image = await loadImage(name, signal)
    try {
      signal.throwIfAborted()
      gl.activeTexture(gl.TEXTURE0 + index)
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, isColor ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, index < 2 ? gl.REPEAT : gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      if (isColor) gl.generateMipmap(gl.TEXTURE_2D)
      if (gl.getError() !== gl.NO_ERROR) {
        gl.deleteTexture(texture)
        gl.bindTexture(gl.TEXTURE_2D, textures[index] ?? null)
        throw new Error(`Unable to upload ${name} lunar texture`)
      }
      if (textures[index]) gl.deleteTexture(textures[index])
      textures[index] = texture
    } finally {
      image.close()
    }
  }

  try {
    const specsRequest = fetch(`${MAP_DIRECTORY}projections.json`, { signal }).then((response) => {
      if (!response.ok) throw new Error('Unable to load the lunar map projections')
      return response.json()
    })
    const results = await Promise.allSettled([
      upload('moon', 0, true),
      upload('global', 1, false),
      upload('north', 2, false),
      upload('south', 3, false),
      specsRequest,
    ])
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
    gl.useProgram(program)
    const specs = results[4].value
    const names = ['albedo', 'globalDem', 'northDem', 'southDem']
    names.forEach((name, index) => gl.uniform1i(uniform(name), index))
    for (const name of ['global', 'north', 'south']) {
      gl.uniform2fv(uniform(`${name}Offset`), specs[name].offset)
      gl.uniform2fv(uniform(`${name}Scale`), specs[name].scale)
    }
    gl.uniform2fv(uniform('globalCenter'), specs.global.center)
    gl.uniform1f(uniform('globalWest'), specs.global.west)
    gl.uniform1f(uniform('polarLimit'), POLAR_LIMIT)
    trek = createTrekMaps(gl, signal, requestRedraw)
    gl.uniform1i(uniform('trekAtlas'), 4)
    gl.uniform1i(uniform('trekIndex'), 5)
    const uniforms = Object.fromEntries(
      ['resolution', 'disc', 'distanceToCamera', 'camera', 'sun', 'shadowEarth', 'trekLevels', 'earth',
        'showCoverage', 'selectedPoints[0]', 'selectionDiametersKm'].map((name) => [name, uniform(name)]),
    )

    let detailRequest
    return {
      improveDetail() {
        if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < 8192) return Promise.resolve()
        detailRequest ??= upload('moon-8k', 0, true)
        return detailRequest
      },
      draw(geometry, ephemeris, zoom, showCoverage, sites) {
        const scale = Math.min(window.devicePixelRatio || 1, 1.5)
        const width = Math.max(1, Math.round(canvas.clientWidth * scale))
        const height = Math.max(1, Math.round(canvas.clientHeight * scale))
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }
        gl.useProgram(program)
        gl.viewport(0, 0, width, height)
        gl.uniform2f(uniforms.resolution, width, height)
        gl.uniform1f(uniforms.disc, discRadius(width, height, zoom))
        gl.uniform1f(uniforms.distanceToCamera, geometry.distance)
        gl.uniformMatrix3fv(uniforms.camera, false, [...geometry.right, ...geometry.up, ...geometry.normal])
        gl.uniform3iv(uniforms.trekLevels, trek.update(geometry, width, height, zoom))
        gl.uniform3fv(uniforms.sun, ephemeris.sun_km)
        gl.uniform3fv(uniforms.shadowEarth, ephemeris.shadow_earth_km)
        gl.uniform3fv(uniforms.earth, geometry.earth)
        gl.uniform1i(uniforms.showCoverage, showCoverage)
        gl.uniform3fv(uniforms['selectedPoints[0]'], sites.flatMap((site) => site?.point ?? [0, 0, 0]))
        gl.uniform2fv(uniforms.selectionDiametersKm, sites.map((site) => site?.diameterKm ?? 0))
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      },
      cleanup,
    }
  } catch (error) {
    cleanup()
    throw error
  }
}

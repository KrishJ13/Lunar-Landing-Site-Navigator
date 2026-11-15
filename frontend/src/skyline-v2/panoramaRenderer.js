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
uniform sampler2D u_horizon;
uniform vec2 u_size;
uniform vec2 u_centre;
uniform vec2 u_span;
uniform float u_bearingStep;
out vec4 color;

float shadeAt(int column, float elevation, float horizon, ivec2 shape) {
  float relative = clamp((horizon - elevation) / max(horizon + 90.0, 1e-6), 0.0, 1.0);
  float row = (1.0 - pow(relative, 1.0 / 3.0)) * float(shape.y - 1);
  vec2 uv = (vec2(float(column), row) + 0.5) / vec2(shape);
  return texture(u_shade, uv).r;
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
  float shade = mix(shadeAt(west, angle.y, westHorizon, shape),
                    shadeAt(east, angle.y, eastHorizon, shape), blend);
  color = vec4(vec3(ground * shade), 1.0);
}
`

/** Draw the cached angular raster with the matching horizon as its sky edge. */
export function createPanoramaRenderer(canvas, { header, arrays }) {
  const gl = canvas.getContext('webgl2', { alpha: false })
  if (!gl) throw new Error('This browser needs WebGL2 to display the terrain panorama.')

  const program = gl.createProgram()
  const shaders = []
  const textures = []
  function dispose() {
    for (const shader of shaders) gl.deleteShader(shader)
    for (const texture of textures) gl.deleteTexture(texture)
    gl.deleteProgram(program)
  }
  function upload(unit, uniform, format, width, height, type, data, filter) {
    const texture = gl.createTexture()
    textures.push(texture)
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texImage2D(gl.TEXTURE_2D, 0, format, width, height, 0, gl.RED, type, data)
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
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Could not upload the terrain panorama.')
    gl.uniform1f(gl.getUniformLocation(program, 'u_bearingStep'), header.skyline.azimuth_step_deg)
    const size = gl.getUniformLocation(program, 'u_size')
    const centre = gl.getUniformLocation(program, 'u_centre')
    const span = gl.getUniformLocation(program, 'u_span')
    return {
      draw({ heading, pitch, fov, width, height }) {
        gl.viewport(0, 0, canvas.width, canvas.height)
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

// Distance colour scale: shades of grey.
//
// Near terrain is darker grey and far terrain lighter grey, on a log scale,
// so 200 m -> 2 km changes shade as much as 20 km -> 200 km. The functions
// keep the names of a general colour map (depthColour, distanceColour, ...)
// so the renderer does not care which scale is used.

import { depth } from './lines.js'

const GREY_NEAR = 70 // grey level for the nearest terrain
const GREY_FAR = 235 // ... and the farthest

/** RGB for a depth 0 (near) .. 1 (far). */
export function depthColour(d) {
  const v = GREY_NEAR + (GREY_FAR - GREY_NEAR) * Math.min(Math.max(d, 0), 1)
  return [v, v, v]
}

/** RGB for terrain `km` away. */
export function distanceColour(km) {
  return depthColour(depth(km))
}

export function rgb([r, g, b], alpha = 1) {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`
}

/** 256-entry lookup table (Uint8 RGB triplets) indexed by round(depth * 255). */
export const DEPTH_LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = depthColour(i / 255)
    lut[i * 3] = r
    lut[i * 3 + 1] = g
    lut[i * 3 + 2] = b
  }
  return lut
})()

/** CSS linear-gradient (left = near, right = far) for legends. */
export function colourBarCss() {
  const stops = []
  for (let i = 0; i <= 10; i++) stops.push(`${rgb(depthColour(i / 10))} ${i * 10}%`)
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

/** Mix a colour towards white by `amount` (0..1), for readable text on black. */
export function lighten([r, g, b], amount) {
  return [r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount]
}

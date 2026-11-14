// Turning the landscape strips into a line drawing.
//
// Input, per compass direction, is the backend's strip of visible terrain
// segments, bottom to top: [el_low, el_high, near_km, far_km, shade, edge, height_m].
//
// RIDGE CRESTS. Where a segment is followed by one with edge = 1, the next
// segment is terrain emerging from BEHIND a nearer ridge. So the top of the
// first segment is that ridge's crest, seen against the farther terrain:
//     crest = (el_high of segment k, far_km of segment k)  if segment k+1 has edge = 1
// The top of the last segment is the skyline, which is also a crest.
//
// DISTANCE CONTOURS. Within one segment, distance grows from near_km at the
// bottom to far_km at the top. A contour at distance d crosses the segment at
//     el = el_low + (el_high - el_low) * ln(d / near) / ln(far / near)
// (interpolating in log-distance, matching how the backend merges samples).
//
// Crests and contour points in neighbouring columns are joined into lines
// when they are at a similar distance and screen height.

const LOW = 0
const HIGH = 1
const NEAR = 2
const FAR = 3
const EDGE = 5

export const CONTOUR_LEVELS_KM = [0.5, 1, 2, 5, 10, 20, 50, 100, 200]

const NEAR_FLOOR_KM = 0.05 // the first segment starts at your feet (0 km)

/** Ridge crests in one strip: [{ el, km, skyline }] bottom to top. */
export function crests(strip) {
  const out = []
  for (let k = 0; k < strip.length; k++) {
    const isSkyline = k === strip.length - 1
    if (isSkyline || strip[k + 1][EDGE] === 1) {
      out.push({ el: strip[k][HIGH], km: strip[k][FAR], skyline: isSkyline })
    }
  }
  return out
}

/** Where each distance contour crosses this strip: [{ el, km }]. */
export function contourPoints(strip, levels = CONTOUR_LEVELS_KM) {
  const out = []
  for (const seg of strip) {
    const near = Math.max(seg[NEAR], NEAR_FLOOR_KM)
    const far = seg[FAR]
    if (far <= near) continue
    for (const d of levels) {
      if (d > near && d <= far) {
        const f = Math.log(d / near) / Math.log(far / near)
        out.push({ el: seg[LOW] + (seg[HIGH] - seg[LOW]) * f, km: d })
      }
    }
  }
  return out
}

// ---- distance styling: nearer = thicker and brighter (depth cue) ----

const STYLE_NEAR_KM = 0.2
const STYLE_FAR_KM = 200
export const STYLE_BUCKETS = 8

/** 0 (near) .. 1 (far) on a log scale. */
export function depth(km) {
  const t = Math.log(Math.max(km, STYLE_NEAR_KM) / STYLE_NEAR_KM) / Math.log(STYLE_FAR_KM / STYLE_NEAR_KM)
  return Math.min(Math.max(t, 0), 1)
}

/** Line width (px) and opacity for a ridge `km` away. */
export function ridgeStyle(km) {
  const t = depth(km)
  return { width: 2.6 - 1.85 * t, alpha: 1 - 0.62 * t }
}

/** Batch index so lines of similar distance can be stroked together. */
export function styleBucket(km) {
  return Math.min(STYLE_BUCKETS - 1, Math.floor(depth(km) * STYLE_BUCKETS))
}

/** Representative distance for a style bucket (its middle). */
export function bucketKm(bucket) {
  const t = (bucket + 0.5) / STYLE_BUCKETS
  return STYLE_NEAR_KM * Math.pow(STYLE_FAR_KM / STYLE_NEAR_KM, t)
}

/**
 * Join points in neighbouring screen columns into line pieces.
 * columns[x] is a list of { y, km } (screen y). Two points join if their
 * distances differ by less than `maxRatio` and their heights by less than
 * `maxDy` pixels. Returns [{ x0, y0, x1, y1, km }].
 */
export function linkColumns(columns, { maxRatio = 1.35, maxDy = 10 } = {}) {
  const pieces = []
  for (let x = 1; x < columns.length; x++) {
    const prev = columns[x - 1]
    for (const p of columns[x]) {
      let best = null
      let bestDy = maxDy
      for (const q of prev) {
        const ratio = p.km > q.km ? p.km / q.km : q.km / p.km
        const dy = Math.abs(p.y - q.y)
        if (ratio <= maxRatio && dy <= bestDy) {
          best = q
          bestDy = dy
        }
      }
      if (best) pieces.push({ x0: x - 1, y0: best.y, x1: x, y1: p.y, km: p.km })
    }
  }
  return pieces
}

/**
 * Prominent peaks on the visible skyline, for distance labels: points that
 * are the highest within `radius` pixels either side. Returns [{ x, y, km }].
 */
export function skylinePeaks(skyY, skyKm, { radius = 70, maxPeaks = 8, minProminence = 4 } = {}) {
  const peaks = []
  for (let x = 0; x < skyY.length; x++) {
    let isPeak = true
    let lowest = skyY[x]
    for (let d = -radius; d <= radius && isPeak; d++) {
      const j = x + d
      if (j < 0 || j >= skyY.length || j === x) continue
      if (skyY[j] < skyY[x] || (skyY[j] === skyY[x] && j < x)) isPeak = false // screen y: smaller = higher
      lowest = Math.max(lowest, skyY[j])
    }
    if (isPeak && lowest - skyY[x] >= minProminence) peaks.push({ x, y: skyY[x], km: skyKm[x] })
  }
  return peaks.sort((a, b) => a.y - b.y).slice(0, maxPeaks)
}

/**
 * Trace points in neighbouring screen columns into whole lines.
 *
 * columns[x] is a list of { y, km }. Moving left to right, each point
 * continues the open line (ending in the previous column) whose distance is
 * within `maxRatio` and whose height is within `maxDy` pixels, closest in
 * height first; otherwise it starts a new line. Returns
 * [{ km, pts: [[x, y], ...] }] with km the line's median distance.
 */
export function traceColumnChains(columns, { maxRatio = 1.35, maxDy = 10 } = {}) {
  const done = []
  let open = [] // chains whose last point is in the previous column
  for (let x = 0; x < columns.length; x++) {
    const next = []
    const taken = new Set()
    for (const p of columns[x]) {
      let best = null
      let bestDy = maxDy
      for (const chain of open) {
        if (taken.has(chain)) continue
        const last = chain.last
        const ratio = p.km > last.km ? p.km / last.km : last.km / p.km
        const dy = Math.abs(p.y - last.y)
        if (ratio <= maxRatio && dy <= bestDy) {
          best = chain
          bestDy = dy
        }
      }
      const chain = best ?? { pts: [], kms: [] }
      if (best) taken.add(best)
      chain.pts.push([x + 0.5, p.y])
      chain.kms.push(p.km)
      chain.last = p
      next.push(chain)
    }
    for (const chain of open) if (!taken.has(chain)) done.push(chain)
    open = next
  }
  done.push(...open)
  return done
    .filter((c) => c.pts.length >= 3)
    .map((c) => {
      const kms = [...c.kms].sort((a, b) => a - b)
      return { km: kms[kms.length >> 1], pts: smoothY(c.pts) }
    })
}

/** Moving-average smoothing of y along a line (window 2r+1, shorter at the ends). */
function smoothY(pts, r = 3) {
  return pts.map(([x], i) => {
    let sum = 0
    let n = 0
    for (let j = Math.max(0, i - r); j <= Math.min(pts.length - 1, i + r); j++) {
      sum += pts[j][1]
      n++
    }
    return [x, sum / n]
  })
}

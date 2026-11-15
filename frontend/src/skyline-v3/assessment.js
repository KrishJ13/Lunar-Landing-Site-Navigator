// Mission assessment over one Skyline V3 time window. No new astronomy or terrain
// model here: every step's Sun and Earth come from the backend's SPICE series
// (POST /api/site/illumination, sun_* / earth_* arrays), and their visibility is
// V3's own ray-cast skyline test (bodies.js visibleFraction), the same figure the
// "Disc visible" column and the first-person view show. Site-wide sunlight comes
// from the backend horizon maps (arrays.mean_lit, arrays.longest_dark_h).
// This file only counts samples and measures runs of them. Run-length handling
// follows lib/assessment.js on feature/nasa-submission-ui.
//
// Durations are resolved to the time step: a run of n samples is reported as
// n x step, which is within one step of the true duration. A run touching either
// end of the window is "open": the real duration may be longer.

import { visibleFraction } from './bodies.js'
import { sunVisibleBesideEarth } from './lighting.js'
import { stepTime } from './sequence.js'

export function missionScenario(inputs, metrics) {
  const { lat, lon, diameterKm, siteName, timeUtc, hours, stepMinutes, eyeHeightM, mastHeightM } = inputs
  return {
    site: { lat, lon, diameterKm, name: siteName },
    time: { startUtc: timeUtc, hours, stepMinutes, eyeHeightM, mastHeightM },
    metrics,
  }
}

export const VISIBLE = 0.001 // any part of the disc above the skyline
export const FULL = 0.999 // the whole disc above the skyline

const body = (arrays, name, k) => ({
  azimuth_deg: arrays[`${name}_azimuth_deg`][k],
  elevation_deg: arrays[`${name}_elevation_deg`][k],
  angular_radius_deg: arrays[`${name}_angular_radius_deg`][k],
})

/**
 * Fraction (0..1) of the Sun's and the Earth's discs above the terrain skyline,
 * seen from the eye at the site centre, at every step. The Sun's fraction also
 * drops where the Earth covers it (an eclipse seen from the Moon), as V3's
 * lighting does (lighting.js; product of the two fractions).
 */
export function visibilitySeries(sequence, terrain) {
  const { arrays, header } = sequence
  const count = header.times.count
  const sun = new Float32Array(count)
  const earth = new Float32Array(count)
  for (let k = 0; k < count; k++) {
    const s = body(arrays, 'sun', k)
    const e = body(arrays, 'earth', k)
    sun[k] = visibleFraction(s, terrain) * sunVisibleBesideEarth(s, e)
    earth[k] = visibleFraction(e, terrain)
  }
  return { sun, earth }
}

/** Longest run of indices where pred(i); open when it touches either end. */
export function longestRun(count, pred) {
  let best = { length: 0, start: -1, open: false }
  let start = -1
  for (let i = 0; i <= count; i++) {
    if (i < count && pred(i)) {
      if (start < 0) start = i
      continue
    }
    if (start >= 0) {
      const length = i - start
      if (length > best.length) best = { length, start, open: start === 0 || i === count }
      start = -1
    }
  }
  return best
}

/** Runs of consecutive indices where pred(i): [{ start, end }] with end exclusive. */
export function runs(count, pred) {
  const out = []
  let start = -1
  for (let i = 0; i <= count; i++) {
    const on = i < count && pred(i)
    if (on && start < 0) start = i
    if (!on && start >= 0) {
      out.push({ start, end: i })
      start = -1
    }
  }
  return out
}

/** First index after k where pred differs from pred(k), or -1 if none in the window. */
export function nextChange(count, pred, k) {
  const now = pred(k)
  for (let i = k + 1; i < count; i++) if (pred(i) !== now) return i
  return -1
}

function bodySummary(fractions, stepHours, windowHours) {
  const count = fractions.length
  let visible = 0
  let full = 0
  for (const f of fractions) {
    if (f > VISIBLE) visible++
    if (f >= FULL) full++
  }
  const blocked = longestRun(count, (i) => fractions[i] <= VISIBLE)
  const clear = longestRun(count, (i) => fractions[i] > VISIBLE)
  return {
    visibleShare: visible / count,
    fullShare: full / count,
    longestBlockedHours: Math.min(blocked.length * stepHours, windowHours),
    longestBlockedOpen: blocked.open,
    longestVisibleHours: Math.min(clear.length * stepHours, windowHours),
    longestVisibleOpen: clear.open,
  }
}

function siteSummary({ header, arrays }) {
  const nodes = header.grid.nx * header.grid.ny
  let sum = 0
  let n = 0
  let best = -1
  for (let i = 0; i < nodes; i++) {
    if (!arrays.in_disc[i]) continue
    sum += arrays.mean_lit[i]
    n++
    if (best < 0 || arrays.mean_lit[i] > arrays.mean_lit[best]) best = i
  }
  return {
    meanSunlit: n ? sum / n : null,
    bestPointSunlit: best >= 0 ? arrays.mean_lit[best] : null,
    bestPointDarkHours: best >= 0 ? arrays.longest_dark_h[best] : null,
    points: n,
    spacingM: header.grid.spacing_m,
    mastHeightM: header.site.mast_height_m,
  }
}

/** Every metric for the window. `series` from visibilitySeries (passed in to share it with the UI). */
export function assess(sequence, terrain, series = visibilitySeries(sequence, terrain)) {
  const { times } = sequence.header
  const count = times.count
  const stepHours = times.step_minutes / 60
  const windowHours = Math.max(count - 1, 1) * stepHours
  let both = 0
  for (let k = 0; k < count; k++) if (series.sun[k] > VISIBLE && series.earth[k] > VISIBLE) both++
  return {
    count,
    stepMinutes: times.step_minutes,
    windowHours,
    startUtc: `${stepTime(times, 0).replace(' ', 'T')}:00Z`,
    endUtc: `${stepTime(times, count - 1).replace(' ', 'T')}:00Z`,
    eyeHeightM: sequence.header.site.eye_height_m,
    skylineStepDeg: terrain.header.skyline.azimuth_step_deg,
    skylineRangeKm: terrain.header.skyline.max_range_m / 1000,
    sun: bodySummary(series.sun, stepHours, windowHours),
    earth: bodySummary(series.earth, stepHours, windowHours),
    bothShare: both / count,
    site: siteSummary(sequence),
  }
}

/** "62 %" / "0.4 %" / "—": never rounds a non-zero share to 0 % or a partial one to 100 %. */
export function formatShare(fraction) {
  if (fraction == null || !Number.isFinite(fraction)) return '—'
  const pct = fraction * 100
  if (pct > 0 && pct < 1) return `${Math.max(0.1, Math.round(pct * 10) / 10).toFixed(1)} %`
  if (pct > 99 && pct < 100) return `${Math.min(99.9, Math.round(pct * 10) / 10).toFixed(1)} %`
  return `${Math.round(pct)} %`
}

/** "45 min", "5 h", "2 d 4 h"; "≥ …" when the run reaches the edge of the window. */
export function formatDuration(hours, open = false) {
  if (hours == null || !Number.isFinite(hours)) return '—'
  if (hours === 0) return 'None'
  let text
  if (hours < 1) text = `${Math.round(hours * 60)} min`
  else {
    const h = Math.round(hours)
    text = h < 48 ? `${h} h` : `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`
  }
  return open && hours > 0 ? `≥ ${text}` : text
}

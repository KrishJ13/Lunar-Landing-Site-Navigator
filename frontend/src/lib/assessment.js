// Mission assessment over one site's time window. No astronomy here: each sample's Sun/Earth
// position is the backend's SPICE value and its terrain visibility is bodyStatus (LOLA
// skyline, lib/celestial.js). This only counts and measures runs of those per-sample states.

import { bodyStatus } from './celestial.js'

/** Any part of the disc above the skyline. */
export const isClear = (s) => s === 'visible' || s === 'partial'
/** Whole disc behind terrain or below the horizon. */
export const isBlocked = (s) => s === 'hidden' || s === 'below'

/**
 * Longest run of consecutive samples matching `pred`. `open` is true when the run touches
 * the start or end of the window, so the real duration may be longer than the window shows.
 */
export function longestRun(states, pred) {
  let best = { length: 0, start: -1, open: false }
  let start = -1
  for (let i = 0; i <= states.length; i++) {
    if (i < states.length && pred(states[i])) {
      if (start < 0) start = i
      continue
    }
    if (start >= 0) {
      const length = i - start
      if (length > best.length) best = { length, start, open: start === 0 || i === states.length }
      start = -1
    }
  }
  return best
}

function bodySummary(states, stepHours, windowHours) {
  const known = states.filter((s) => s !== 'unknown').length
  const clear = states.filter(isClear).length
  const full = states.filter((s) => s === 'visible').length
  const blockedRun = longestRun(states, isBlocked)
  return {
    known,
    unknown: states.length - known,
    clearFraction: known ? clear / known : null,
    fullFraction: known ? full / known : null,
    // Each sample stands for one step; the window's samples include both ends, so cap there.
    longestBlockedHours: Math.min(blockedRun.length * stepHours, windowHours),
    longestBlockedOpen: blockedRun.open,
    // Earth or Sun blocked for the whole (known) window.
    alwaysBlocked: known > 0 && states.every((s) => s === 'unknown' || isBlocked(s)),
  }
}

/**
 * Per-sample terrain-aware states for the Sun and Earth plus summary metrics.
 * Durations are sample counts x step, so they are resolved to the sampling step.
 */
export function assessSeries(series, skyline) {
  const samples = series?.samples ?? []
  const stepHours = (series?.step_minutes ?? 60) / 60
  const sun = samples.map((s) => bodyStatus(s.sun, skyline))
  const earth = samples.map((s) => bodyStatus(s.earth, skyline))
  const bothKnown = sun.filter((s, i) => s !== 'unknown' && earth[i] !== 'unknown').length
  const both = sun.filter((s, i) => isClear(s) && isClear(earth[i])).length
  const windowHours = Math.max(samples.length - 1, 1) * stepHours // samples include both ends
  return {
    count: samples.length,
    stepHours,
    windowHours,
    states: { sun, earth },
    sun: bodySummary(sun, stepHours, windowHours),
    earth: bodySummary(earth, stepHours, windowHours),
    bothFraction: bothKnown ? both / bothKnown : null,
  }
}

/** "62%" / "0.4%" / "—" (never rounds a non-zero share to 0% or a partial one to 100%). */
export function formatShare(fraction) {
  if (fraction == null) return '—'
  const pct = fraction * 100
  if (pct > 0 && pct < 1) return `${pct.toFixed(1)}%`
  if (pct > 99 && pct < 100) return `${pct.toFixed(1)}%`
  return `${Math.round(pct)}%`
}

/** "0 h", "5 h", "2 d 4 h"; prefixed with ≥ when the run reaches the edge of the window. */
export function formatDuration(hours, open = false) {
  const h = Math.round(hours)
  const text = h < 48 ? `${h} h` : `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`
  return open && h > 0 ? `≥ ${text}` : text
}

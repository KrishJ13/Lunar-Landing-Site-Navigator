// Presentation helpers for the Sun and Earth: how to describe each body's state and where
// to point the view to find it. No astronomy here: azimuth, elevation, radius and the
// terrain skyline all come from the backend (SPICE / LOLA); visibility is view.js's
// bodyVisibility. These only classify, label and format those values.

import { bodyVisibility, wrap360 } from './view.js'

export const PITCH_LIMIT = 60 // how far the first-person view can tilt, degrees

export const BODIES = [
  { key: 'sun', label: 'Sun', shortcut: 's' },
  { key: 'earth', label: 'Earth', shortcut: 'e' },
]

/** Longer wording for readouts, shorter for labels drawn on the canvas. */
export const STATUS = {
  visible: { text: 'Visible', short: '' },
  partial: { text: 'Partly behind terrain', short: ' (partly behind terrain)' },
  hidden: { text: 'Behind terrain', short: ' (behind terrain)' },
  below: { text: 'Below horizon', short: ' (below horizon)' },
  unknown: { text: 'Terrain visibility unknown', short: ' (terrain unknown)' },
  pending: { text: 'Position not loaded', short: '' },
}

/**
 * One of 'visible' | 'partial' | 'hidden' | 'below' | 'unknown' | 'pending'.
 * 'below' is a hidden body that is also under the local horizontal plane; 'pending' means
 * no SPICE sample is available yet.
 */
export function bodyStatus(body, skyline) {
  if (!body) return 'pending'
  const vis = bodyVisibility(body, skyline)
  return vis === 'hidden' && body.elevation_deg < 0 ? 'below' : vis
}

/** View direction that centres a body: its compass azimuth, and its elevation as the tilt. */
export function lookTarget(body) {
  return {
    heading: wrap360(body.azimuth_deg),
    pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, body.elevation_deg)),
  }
}

/** "2026-11-14 06:00 UTC" from an ISO timestamp (no timezone conversion: the API is UTC). */
export function formatUtc(timestamp) {
  return `${timestamp.slice(0, 10)} ${timestamp.slice(11, 16)} UTC`
}

/** Simulated time per real second of playback, e.g. 60 min x 5 -> "5 h/s". */
export function formatRate(stepMinutes, speed) {
  const minutes = stepMinutes * speed
  if (minutes < 60) return `${+minutes.toFixed(1)} min/s`
  return `${+(minutes / 60).toFixed(1)} h/s`
}

import { STATUS } from '../lib/celestial.js'

// Redundant (non-colour) cue for each state, so the chips read without colour vision.
const GLYPH = { visible: '●', partial: '◐', hidden: '○', below: '▽', unknown: '?', pending: '…' }

/** Terrain-visibility state of a celestial body (see bodyStatus in lib/celestial.js). */
export default function StatusChip({ status, children }) {
  return (
    <span className={`status status-${status}`}>
      <span aria-hidden="true">{GLYPH[status]} </span>
      {STATUS[status].text}
      {children}
    </span>
  )
}

import { BODIES } from '../lib/celestial.js'
import StatusChip from './StatusChip.jsx'

/**
 * Find Sun / Find Earth: turns the first-person view to a body and shows its current state.
 * `bodies` is the SPICE sample for the selected time, so the readout follows the timeline.
 */
export default function CelestialFinder({ bodies, statuses, following, onFind }) {
  return (
    <div className="finder" role="group" aria-label="Find the Sun or Earth">
      {BODIES.map(({ key, label, shortcut }) => {
        const b = bodies?.[key]
        const status = statuses?.[key] ?? 'pending'
        return (
          <button
            key={key}
            type="button"
            className={`find find-${key}`}
            disabled={!b}
            aria-pressed={following === key}
            aria-keyshortcuts={shortcut.toUpperCase()}
            title={
              b
                ? `Turn to the ${label} and keep it centred as the time changes (${shortcut.toUpperCase()})`
                : `${label} position is not loaded yet`
            }
            onClick={() => onFind(key)}
          >
            <span className="body-dot" aria-hidden="true" />
            <span className="find-text">
              <span className="find-name">
                Find {label} <kbd aria-hidden="true">{shortcut.toUpperCase()}</kbd>
              </span>
              <StatusChip status={status}>
                {b && (
                  <span className="find-coords">
                    {' '}
                    · az {b.azimuth_deg.toFixed(1)}° el {b.elevation_deg.toFixed(1)}°
                  </span>
                )}
              </StatusChip>
            </span>
          </button>
        )
      })}
    </div>
  )
}

import { useState } from 'react'
import { SLOTS, saveScenario } from '../lib/journey.js'

export default function ScenarioSaveActions({ scenario, scenarios }) {
  const [status, setStatus] = useState(null)

  function save(slot) {
    const saved = saveScenario(slot, scenario)
    const message = saved ? `Saved as Scenario ${slot}.` : 'Could not save. Browser storage is unavailable.'
    setStatus({ scenario, message })
  }

  return (
    <div className="sk-save" role="group" aria-label="Save for comparison">
      {SLOTS.map((slot) => (
        <button key={slot} type="button" className={`sk-slot-btn sk-slot-${slot}`} onClick={() => save(slot)}>
          {scenarios[slot] ? `Replace Scenario ${slot}` : `Save as Scenario ${slot}`}
        </button>
      ))}
      {status?.scenario === scenario && <span className="v2-muted v2-note" role="status">{status.message}</span>}
    </div>
  )
}

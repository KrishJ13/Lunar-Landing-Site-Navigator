import { useRef, useState } from 'react'
import { fetchView } from '../api/horizon.js'
import FirstPersonView from './FirstPersonView.jsx'
import HorizonFacts from './HorizonFacts.jsx'
import SiteForm from './SiteForm.jsx'
import SitePanel from './SitePanel.jsx'

/**
 * One site to look at: its own form (place, date, eye height), its movable
 * first-person view, and its information below. Several tiles can sit side
 * by side for comparison; each keeps its own state and can be closed alone.
 */
export default function SiteTile({ label, initialPresetIndex, compact, onClose, viewRef }) {
  const [data, setData] = useState(null)
  const [request, setRequest] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const inFlight = useRef(null)

  async function compute(params) {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setLoading(true)
    setError(null)
    try {
      setData(await fetchView(params, controller.signal))
      setRequest(params)
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message)
    } finally {
      if (inFlight.current === controller) setLoading(false)
    }
  }

  return (
    <article className="site-tile" aria-label={label}>
      <header className="tile-header">
        <div>
          <span className="tile-label">{label}</span>
          {request && (
            <span className="tile-title">
              {request.siteName ?? `${request.lat.toFixed(3)}°, ${request.lon.toFixed(3)}°E`} · {request.date}
            </span>
          )}
        </div>
        {onClose && (
          <button type="button" className="tile-close" onClick={onClose} aria-label={`Close ${label}`}>
            ×
          </button>
        )}
      </header>

      <SiteForm onSubmit={compute} loading={loading} initialPresetIndex={initialPresetIndex} />

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {data && (
        <div className="result" aria-busy={loading}>
          <FirstPersonView data={data} viewHeight={compact ? 340 : 420} ref={viewRef} />
          <p className="muted small date-note">
            Date {request.date} (UTC). The terrain and horizon do not depend on the date; Sun and Earth positions for
            this date will be added to the view.
          </p>
          <SitePanel data={data} />
          <HorizonFacts data={data} />
        </div>
      )}
    </article>
  )
}

import { useMemo, useRef, useState } from 'react'
import { fetchView } from '../api/horizon.js'
import { fetchSeries } from '../api/sky.js'
import { bodyVisibility } from '../lib/view.js'
import { usePlayback } from '../lib/usePlayback.js'
import FirstPersonView from './FirstPersonView.jsx'
import HorizonFacts from './HorizonFacts.jsx'
import SiteForm from './SiteForm.jsx'
import SitePanel from './SitePanel.jsx'
import SkyPanel from './SkyPanel.jsx'

const STEP_MINUTES = 60

/**
 * One site to look at: its own form (place, UTC start, eye height), its movable
 * first-person view with Sun/Earth markers, its sky chart and time playback, and
 * its information below. Each tile keeps its own state (coordinates, dates, eye
 * height, series, playback) and can be closed alone.
 *
 * Request order: terrain (/api/view) first, then SPICE (/api/v1/positions/series) at
 * observer elevation = LOLA ground height + eye height. If SPICE fails the terrain
 * view still shows, with the error beside it.
 */
export default function SiteTile({ label, initialPresetIndex, compact, onClose, viewRef }) {
  const [data, setData] = useState(null)
  const [series, setSeries] = useState(null)
  const [request, setRequest] = useState(null)
  const [error, setError] = useState(null)
  const [skyError, setSkyError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState('sun')
  const inFlight = useRef(null)
  const playback = usePlayback(series?.samples.length ?? 0)

  async function compute(params) {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setLoading(true)
    setError(null)
    setSkyError(null)
    setSeries(null) // never show a series that belongs to different inputs
    playback.reset()
    try {
      const view = await fetchView(params, controller.signal)
      setData(view)
      setRequest(params)
      try {
        const res = await fetchSeries(
          {
            lat: params.lat,
            lon: params.lon,
            elevationM: view.site_info.eye_m,
            startUtc: params.startUtc,
            hours: params.hours,
            stepMinutes: STEP_MINUTES,
          },
          controller.signal,
        )
        setSeries(res)
      } catch (err) {
        if (err.name !== 'AbortError') setSkyError(err.message)
      }
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message)
    } finally {
      if (inFlight.current === controller) setLoading(false)
    }
  }

  const sample = series?.samples[playback.idx]
  const bodies = useMemo(() => (sample ? { sun: sample.sun, earth: sample.earth } : null), [sample])
  // Visible fraction (0..1) of each disc above the drawn terrain.
  const visibility = useMemo(
    () =>
      bodies && data
        ? { sun: bodyVisibility(bodies.sun, data.landscape), earth: bodyVisibility(bodies.earth, data.landscape) }
        : null,
    [bodies, data],
  )

  return (
    <article className="site-tile" aria-label={label}>
      <header className="tile-header">
        <div>
          <span className="tile-label">{label}</span>
          {request && (
            <span className="tile-title">
              {request.siteName ?? `${request.lat.toFixed(3)}°, ${request.lon.toFixed(3)}°E`} · {request.startUtc.slice(0, 16).replace('T', ' ')} UTC
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
          <FirstPersonView data={data} viewHeight={compact ? 340 : 420} bodies={bodies} ref={viewRef} />
          {skyError && (
            <p className="error" role="alert">
              Sun and Earth positions unavailable: {skyError}
            </p>
          )}
          {series && (
            <SkyPanel
              series={series}
              playback={playback}
              selected={selected}
              onSelect={setSelected}
              visibility={visibility}
            />
          )}
          <SitePanel data={data} />
          <HorizonFacts data={data} />
        </div>
      )}
    </article>
  )
}

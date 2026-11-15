import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchView } from '../api/horizon.js'
import { fetchSeries } from '../api/sky.js'
import { assessSeries } from '../lib/assessment.js'
import MissionAssessment from './MissionAssessment.jsx'
import { bodyStatus, formatUtc } from '../lib/celestial.js'
import { useMediaQuery } from '../lib/useMediaQuery.js'
import { usePlayback } from '../lib/usePlayback.js'
import { formatHeight } from '../lib/view.js'
import FirstPersonView from './FirstPersonView.jsx'
import HorizonFacts from './HorizonFacts.jsx'
import SiteForm from './SiteForm.jsx'
import SitePanel from './SitePanel.jsx'
import SkyPanel from './SkyPanel.jsx'
import TimeControls from './TimeControls.jsx'

const STEP_MINUTES = 60

// The terrain depends only on these; the date and range only select the Sun/Earth series.
const sameTerrain = (a, b) =>
  a.lat === b.lat && a.lon === b.lon && a.observerHeightM === b.observerHeightM && a.azimuthStepDeg === b.azimuthStepDeg

/**
 * One site to look at: its own settings (place, UTC start, eye height), its movable
 * first-person view with Sun/Earth markers and Find buttons, its UTC timeline and playback,
 * its sky chart and its terrain details. Each tile keeps its own state (coordinates, dates,
 * eye height, series, playback) and can be closed alone.
 *
 * Request order: terrain (/api/view) first, then SPICE (/api/v1/positions/series) at
 * observer elevation = LOLA ground height + eye height. If SPICE fails the terrain
 * view still shows, with the error beside it. Changing only the start time or range reuses
 * the terrain already on screen and requests just the new series.
 */
export default function SiteTile({ id, label, initialPresetIndex, compact, onClose, viewRef, onSummary }) {
  const [data, setData] = useState(null)
  const [series, setSeries] = useState(null)
  const [request, setRequest] = useState(null) // inputs the terrain on screen was fetched for
  const [error, setError] = useState(null)
  const [skyError, setSkyError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [formOpen, setFormOpen] = useState(true)
  const inFlight = useRef(null)
  const latest = useRef(null) // most recently submitted inputs (may still be loading)
  const playback = usePlayback(series?.samples.length ?? 0)
  const narrow = useMediaQuery('(max-width: 640px)')

  async function load(params) {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    latest.current = params
    setLoading(true)
    setError(null)
    setSkyError(null)
    setSeries(null) // never show a series that belongs to different inputs
    playback.reset()
    try {
      let view = data
      if (!view || !request || !sameTerrain(request, params)) {
        view = await fetchView(params, controller.signal)
        setData(view)
        if (!data) setFormOpen(false) // first result: give the view the room
      }
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

  const changeTime = ({ startUtc, hours }) => {
    if (latest.current) load({ ...latest.current, startUtc, hours })
  }

  const sample = series?.samples[playback.idx]
  const bodies = useMemo(() => (sample ? { sun: sample.sun, earth: sample.earth } : null), [sample])
  const statuses = useMemo(
    () => (bodies && data ? { sun: bodyStatus(bodies.sun, data.skyline), earth: bodyStatus(bodies.earth, data.skyline) } : null),
    [bodies, data],
  )

  const assessment = useMemo(() => (series && data ? assessSeries(series, data.skyline) : null), [series, data])

  const skyLoading = loading && !series && !skyError
  const where = request && (request.siteName ?? `${request.lat.toFixed(3)}°, ${request.lon.toFixed(3)}°E`)

  // Tell the page what this tile shows, for the side-by-side comparison and the step guide.
  // onSummary must be stable (useCallback in the parent), keyed by this tile's id.
  useEffect(() => {
    onSummary?.(
      id,
      request && data
        ? { label, where, startUtc: request.startUtc, hours: request.hours, eyeM: request.observerHeightM, assessment }
        : null,
    )
  }, [onSummary, id, label, where, request, data, assessment])
  useEffect(() => () => onSummary?.(id, null), [onSummary, id])

  return (
    <article className="site-tile" aria-label={label}>
      <header className="tile-header">
        <div className="tile-id">
          <span className="tile-label">{label}</span>
          {request && (
            <span className="tile-title">
              {where}
              <span className="muted"> · {formatUtc(request.startUtc)}</span>
            </span>
          )}
        </div>
        {onClose && (
          <button type="button" className="tile-close" onClick={onClose} aria-label={`Close ${label}`}>
            ×
          </button>
        )}
      </header>

      <details className="settings" open={formOpen} onToggle={(e) => setFormOpen(e.currentTarget.open)}>
        <summary>
          <span>Location, time and observer</span>
          {request && (
            <span className="muted small">
              {where} · eye {request.observerHeightM} m · {request.hours} h from {formatUtc(request.startUtc)}
            </span>
          )}
        </summary>
        <SiteForm
          onSubmit={load}
          onTimeChange={changeTime}
          loading={loading}
          applied={request}
          initialPresetIndex={initialPresetIndex}
          autoSubmit
        />
      </details>

      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}

      {!data && !error && (
        <div className={`empty-state${loading ? ' busy' : ''}`} role="status">
          {loading ? (
            <p>Reconstructing the LOLA terrain for this site…</p>
          ) : (
            <p>
              Choose a site and press <strong>Stand here</strong> to see the lunar horizon, the Sun and Earth.
            </p>
          )}
        </div>
      )}

      {data && (
        <div className="result" aria-busy={loading}>
          <FirstPersonView
            data={data}
            viewHeight={narrow ? 300 : compact ? 340 : 420}
            bodies={bodies}
            statuses={statuses}
            ref={viewRef}
          />

          {skyError && (
            <p className="message error" role="alert">
              Sun and Earth positions unavailable: {skyError}{' '}
              <button type="button" className="link-button" onClick={() => load(latest.current)}>
                Retry
              </button>
            </p>
          )}
          {skyLoading && (
            <div className="empty-state busy" role="status">
              <p>Loading Sun and Earth positions from SPICE…</p>
            </div>
          )}
          {series && (
            <>
              <TimeControls series={series} playback={playback} assessment={assessment} />
              {assessment && <MissionAssessment assessment={assessment} />}
              <SkyPanel sample={sample} site={series.site} statuses={statuses} />
            </>
          )}

          <details className="terrain-details">
            <summary>
              <span>Terrain details</span>
              <span className="muted small">
                ground {formatHeight(data.site_info.ground_m)} · slope {data.site_info.slope_deg.toFixed(1)}° · {data.site_info.setting}
              </span>
            </summary>
            <SitePanel data={data} />
            <HorizonFacts data={data} />
          </details>
        </div>
      )}
    </article>
  )
}

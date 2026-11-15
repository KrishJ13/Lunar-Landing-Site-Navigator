import { memo } from 'react'
import { skylineAt } from './bodies.js'
import { formatDuration as duration } from './sequence.js'

const formatUtc = (ms) => new Date(Math.round(ms / 60_000) * 60_000)
  .toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 })

function missionShare(seconds, total) {
  const share = seconds / total
  if (share > 0 && share < 0.001) return `<${percent.format(0.001)}`
  if (share < 1 && share > 0.999) return `>${percent.format(0.999)}`
  return percent.format(share)
}

const RISE_SET = {
  sun: { set: 'Sunset', rise: 'Sunrise' },
  earth: { set: 'Earthset', rise: 'Earthrise' },
}

function windowLabel(window, result) {
  const start = Date.parse(result.start_utc)
  const from = formatUtc(start + window.start_s * 1000) + (window.start_s === 0 ? ' (mission start)' : '')
  const to = formatUtc(start + window.end_s * 1000) + (window.end_s === result.duration_s ? ' (mission end)' : '')
  return `${from} → ${to}`
}

function longestGap(windows, end) {
  let previousEnd = 0
  let longest = 0
  for (const window of windows) {
    longest = Math.max(longest, window.start_s - previousEnd)
    previousEnd = window.end_s
  }
  return Math.max(longest, end - previousEnd)
}

function MissionMetric({ body, result, title, gapLabel, loading }) {
  const stats = result?.[body]
  return (
    <section className={`v3-mission-card v3-${body}`} aria-label={title}>
      <h3>{title}</h3>
      {stats ? <>
        <p className="v3-mission-total"><strong>{duration(stats.visible_duration_s)}</strong>
          <span>{missionShare(stats.visible_duration_s, result.duration_s)} of mission</span>
        </p>
        <p className="v3-mission-gap">{gapLabel} <strong>{duration(longestGap(stats.windows, result.duration_s))}</strong></p>
      </> : <p className="v2-muted">{loading ? 'Calculating…' : 'Unavailable'}</p>}
    </section>
  )
}

export const MissionDetails = memo(function MissionDetails({ inputs, terrain, windows, loading }) {
  const start = Date.parse(inputs.timeUtc)
  const total = inputs.hours * 3600
  return (
    <section className="v3-site-overview" aria-label="Mission details">
      <header className="v3-mission-head">
        <h2>Mission details</h2>
        <div className="v3-mission-dates">
          <span>{formatUtc(start)} → {formatUtc(start + total * 1000)}</span>
          <strong>{duration(total)}</strong>
        </div>
      </header>
      <div className="v3-site-metrics">
        <MissionMetric body="sun" title="Time in sunlight" gapLabel="Longest stretch in darkness"
          result={windows} loading={loading} />
        <MissionMetric body="earth" title="Time with Earth in view" gapLabel="Longest stretch without Earth in view"
          result={windows} loading={loading} />
      </div>
      {terrain && windows && <p className="v2-muted v2-note">
        Estimated at {terrain.header.site.eye_height_m} m above ground.
      </p>}
    </section>
  )
})

function Status({ body, result, elapsed, elevation }) {
  const { windows, events } = result[body]
  const name = body === 'sun' ? 'Sun' : 'Earth'
  const visible = windows.some(({ start_s, end_s }) => start_s <= elapsed &&
    (elapsed < end_s || end_s === result.duration_s))
  const withinMission = events.find(({ at_s }) => at_s > elapsed)
  const next = withinMission ?? result.after_mission?.events[body]
  const start = Date.parse(result.start_utc)
  const kind = next?.kind ?? (visible ? 'set' : 'rise')
  return (
    <section className={`v3-time-status v3-${body}`} aria-label={`${name} visibility timing`}>
      <h3>{RISE_SET[body][kind]}</h3>
      {next ? <>
        <p className="v3-event-countdown">In {duration(next.at_s - elapsed)}</p>
        <p>About {formatUtc(start + next.at_s * 1000)}{!withinMission && ' · After mission end'}</p>
      </> : (
        <p>{result.after_mission
          ? `None found through ${formatUtc(start + result.after_mission.searched_until_s * 1000)}`
          : 'None found before mission end'}</p>
      )}
      <p className="v2-muted">{name} {visible ? 'in view' : 'out of view'}{elevation !== undefined && (
        <> · {elevation.toFixed(2)}° elevation</>
      )}</p>
    </section>
  )
}

export function SelectedTimeDetails({ inputs, bodies, windows, elapsed, loading }) {
  const time = formatUtc(Date.parse(inputs.timeUtc) + elapsed * 1000)
  return (
    <section className="v3-view-conditions" aria-label="Conditions at selected time">
      <h2>{elapsed === 0 ? 'At landing' : 'At selected time'} <span>{time}</span></h2>
      {windows ? <div className="v3-time-status-grid">
        <Status body="sun" result={windows} elapsed={elapsed} elevation={bodies?.sun.elevation_deg} />
        <Status body="earth" result={windows} elapsed={elapsed} elevation={bodies?.earth.elevation_deg} />
      </div> : <p className="v2-muted">
        {loading ? 'Calculating rise and set times…' : 'Rise and set times unavailable.'}
        {bodies && ` · Sun ${bodies.sun.elevation_deg.toFixed(2)}° · Earth ${bodies.earth.elevation_deg.toFixed(2)}° elevation`}
      </p>}
    </section>
  )
}

export function EarthCommunications({ windows, elapsed, bodies, terrain, frameSeconds, lastFrame, onSelectFrame }) {
  const schedule = windows.earth.windows
  const upcoming = schedule.find((window) =>
    window.end_s > elapsed || (window.end_s === windows.duration_s && window.end_s === elapsed))
  const active = upcoming && upcoming.start_s <= elapsed
  const earth = bodies?.earth
  const currentDirection = active && earth && terrain ? {
    azimuth_deg: earth.azimuth_deg,
    elevation_deg: earth.elevation_deg,
    clearance_deg: earth.elevation_deg - skylineAt(terrain, earth.azimuth_deg),
  } : null
  const direction = currentDirection ?? upcoming?.opening_direction

  function windowButton(window, label) {
    if (!frameSeconds) return null
    const firstFrame = Math.ceil(window.start_s / frameSeconds)
    const frameTime = firstFrame * frameSeconds
    if (firstFrame > lastFrame ||
      (frameTime >= window.end_s && !(frameTime === window.end_s && window.end_s === windows.duration_s))) return null
    return <button type="button" onClick={() => onSelectFrame(firstFrame)}>{label}</button>
  }

  return (
    <section className="v3-earth-comms v3-earth" aria-label="Earth communications">
      <header>
        <h2>Earth communications</h2>
        <p className="v2-muted">Direct-to-Earth line of sight</p>
      </header>
      {upcoming ? <>
        <div className="v3-comms-layout">
          <div className="v3-comms-window">
            <h3>{active ? 'Earth in view' : 'Next window'}</h3>
            <p>{windowLabel(upcoming, windows)}</p>
            <p><strong>{duration(upcoming.end_s - upcoming.start_s)}</strong> total
              {' · '}{active ? `${duration(upcoming.end_s - elapsed)} left` : `Opens in ${duration(upcoming.start_s - elapsed)}`}</p>
            {windowButton(upcoming, 'Show window in terrain view')}
          </div>
          {direction && <div className="v3-comms-pointing">
            <h3>{currentDirection ? 'Where to point at selected time' : 'Where to point when window opens'}</h3>
            <dl>
              <div><dt>Bearing clockwise from north</dt><dd>{(Math.round(direction.azimuth_deg * 10) % 3600 / 10).toFixed(1)}°</dd></div>
              <div><dt>Elevation from level</dt><dd>{direction.elevation_deg.toFixed(2)}°</dd></div>
              <div><dt>Clearance above terrain</dt><dd>{Math.abs(direction.clearance_deg) < 0.005
                ? '0.00' : direction.clearance_deg.toFixed(2)}°</dd></div>
            </dl>
          </div>}
        </div>
      </> : <p>{schedule.length ? 'No further Earth visibility windows before mission end.' : 'No Earth visibility during this mission.'}</p>}
      {!!schedule.length && <details className="v3-mission-window-list">
        <summary>All mission windows ({schedule.length})</summary>
        <ol>{schedule.map((window, index) => <li key={window.start_s}>
          <span>{windowLabel(window, windows)} · <strong>{duration(window.end_s - window.start_s)}</strong></span>
          {windowButton(window, `View window ${index + 1}`)}
        </li>)}</ol>
      </details>}
      <p className="v2-muted v2-note">Uses Earth’s centre and local terrain. Radio availability depends on the receiving station and equipment.</p>
    </section>
  )
}

function WindowTrack({ body, label, result, elapsed }) {
  const { windows, visible_duration_s: total } = result[body]
  const position = (seconds) => `${seconds / result.duration_s * 100}%`
  return (
    <div className={`v3-window-track v3-${body}`}>
      <span className="v3-track-label">{label}</span>
      <div className="v3-track-bar" role="img" aria-label={`${label}, ${duration(total)} during the mission`}>
        {windows.map(({ start_s, end_s }) => <span key={start_s} className="v3-track-fill"
          style={{ left: position(start_s), width: position(end_s - start_s) }} />)}
        <span className="v3-track-cursor" style={{ left: position(elapsed) }} />
      </div>
    </div>
  )
}

export function VisibilityTracks({ windows, elapsed }) {
  return (
    <figure className="v3-visibility-tracks">
      <figcaption>When the Sun and Earth are visible</figcaption>
      <WindowTrack body="sun" label="Sunlight" result={windows} elapsed={elapsed} />
      <WindowTrack body="earth" label="Earth in view" result={windows} elapsed={elapsed} />
      <div className="v3-track-axis v2-muted"><span>Mission start</span><span>Mission end</span></div>
    </figure>
  )
}

import { useCallback, useRef, useState } from 'react'
import ComparisonTable from './components/ComparisonTable.jsx'
import SiteTile from './components/SiteTile.jsx'
import { colourBarCss } from './lib/colormap.js'
import { depth } from './lib/lines.js'
import { formatDistanceShort } from './lib/view.js'
import './App.css'

let nextTileId = 1

function App() {
  // Up to two site tiles, side by side for comparison.
  const [tiles, setTiles] = useState([{ id: nextTileId++, presetIndex: 0 }])
  const views = useRef(new Map()) // tile id -> its first-person view handle
  const [summaries, setSummaries] = useState({}) // tile id -> what the tile shows (or absent)

  const onSummary = useCallback((id, summary) => {
    setSummaries((prev) => {
      if (!summary) {
        if (!(id in prev)) return prev
        const { [id]: _gone, ...rest } = prev // eslint-disable-line no-unused-vars
        return rest
      }
      return { ...prev, [id]: summary }
    })
  }, [])

  const shown = tiles.map((t) => summaries[t.id]).filter(Boolean)
  const assessed = shown.filter((s) => s.assessment).length

  /** Level every open view at once, so the eye-level lines line up side by side. */
  function alignEyeLevels() {
    for (const view of views.current.values()) view?.level()
  }

  function addTile() {
    // Start the new tile on a different preset so the comparison is useful at once.
    setTiles((t) => (t.length >= 2 ? t : [...t, { id: nextTileId++, presetIndex: 1 }]))
  }

  function closeTile(id) {
    setTiles((t) => t.filter((tile) => tile.id !== id))
  }

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">NASA Space Apps 2026 · Lunar surface visibility</p>
          <h1>Lunar Skyline</h1>
          <p className="lede">
            Pick a landing site and a UTC date to see the real lunar horizon, and when the Sun (power) and Earth (direct
            communication) are above it. Compare two sites, or one site on two dates.
          </p>
        </div>
        <ul className="sources" aria-label="Data sources">
          <li>
            <span>Terrain</span> NASA LOLA elevation
          </li>
          <li>
            <span>Sun and Earth</span> JPL SPICE ephemerides
          </li>
          <li>
            <span>Time</span> UTC
          </li>
        </ul>
      </header>

      <Steps reached={shown.length > 0 ? (assessed > 0 ? (assessed > 1 ? 5 : 4) : 3) : 0} />

      <div className="toolbar" role="toolbar" aria-label="Site comparison">
        <span className="muted small">
          {tiles.length === 2
            ? 'Comparing two scenarios: each site has its own place, date and timeline.'
            : tiles.length === 1
              ? 'One site open. Add a second to compare places or dates.'
              : 'No sites open'}
        </span>
        <span className="toolbar-actions">
          {tiles.length === 2 && (
            <button type="button" onClick={alignEyeLevels}>
              Align eye levels
            </button>
          )}
          {tiles.length < 2 && (
            <button type="button" className={shown.length ? 'primary' : undefined} onClick={addTile}>
              {tiles.length === 0 ? '+ Add a site' : '+ Compare with another site'}
            </button>
          )}
        </span>
      </div>

      <div className={tiles.length > 1 ? 'tiles two' : 'tiles'}>
        {tiles.map((tile, i) => (
          <SiteTile
            key={tile.id}
            id={tile.id}
            onSummary={onSummary}
            label={`Site ${String.fromCharCode(65 + i)}`}
            initialPresetIndex={tile.presetIndex}
            compact={tiles.length > 1}
            onClose={() => closeTile(tile.id)}
            viewRef={(handle) => {
              if (handle) views.current.set(tile.id, handle)
              else views.current.delete(tile.id)
            }}
          />
        ))}
      </div>

      <ComparisonTable summaries={shown} />

      <DistanceLegend />
    </main>
  )
}

const STEPS = [
  ['Select site', 'Preset or coordinates'],
  ['Choose date', 'UTC start and window'],
  ['Explore skyline', 'Drag the view, Find Sun/Earth'],
  ['Assess conditions', 'Sunlight and Earth line of sight'],
  ['Compare', 'Add a second site or date'],
]

/** The workflow at a glance; steps tick off as each one has a result on screen. */
function Steps({ reached }) {
  return (
    <ol className="steps" aria-label="How to use Lunar Skyline">
      {STEPS.map(([title, hint], i) => {
        const state = i < reached ? 'done' : i === reached ? 'current' : 'todo'
        return (
          <li key={title} className={`step step-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="step-num" aria-hidden="true">
              {state === 'done' ? '✓' : i + 1}
            </span>
            <span className="step-text">
              <span className="step-title">{title}</span>
              <span className="step-hint">{hint}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** How to read the views (shared by all tiles). */
function DistanceLegend() {
  const ticks = [0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200]
  return (
    <section className="legend" aria-label="How to read the view">
      <div className="legend-block legend-distance">
        <h2>Distance from you</h2>
        <div className="scale">
          <div className="colour-bar" style={{ background: colourBarCss() }} />
          <div className="colour-ticks">
            {ticks.map((km) => (
              <span key={km} style={{ left: `${depth(km) * 100}%` }}>
                {formatDistanceShort(km)}
              </span>
            ))}
          </div>
        </div>
        <p className="legend-note">
          Darker grey = nearer, lighter grey = farther, for both the terrain and its lines. Lines are ridge crests (which
          hide terrain behind them) and distance contours (0.5, 1, 2, 5, 10 … km from you). Views are at true proportions.
          Hover anywhere for the exact distance and height.
        </p>
      </div>
      <div className="legend-block">
        <h2>Sun and Earth markers</h2>
        <ul className="marker-key">
          <li>
            <span className="key-disc sun" aria-hidden="true" />
            <span className="key-disc earth" aria-hidden="true" />
            <span>Drawn at true angular size. Solid: visible above the skyline.</span>
          </li>
          <li>
            <span className="key-disc sun partial" aria-hidden="true" />
            <span>Solid part above the skyline, dashed ghost behind terrain: partly obscured.</span>
          </li>
          <li>
            <span className="key-disc sun ghost" aria-hidden="true" />
            <span>Dashed ghost only: behind terrain or below the horizon.</span>
          </li>
          <li>
            <span className="key-disc ghost unknown" aria-hidden="true" />
            <span>Labelled &quot;terrain unknown&quot;: the skyline is unavailable in that direction.</span>
          </li>
        </ul>
      </div>
    </section>
  )
}

export default App

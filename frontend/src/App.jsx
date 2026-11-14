import { useRef, useState } from 'react'
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
        <h1>Lunar Skyline</h1>
        <p className="lede">
          Stand anywhere on the Moon and look around. The landscape and horizon come from NASA LOLA elevation data;
          the Sun and Earth come from JPL SPICE ephemerides at your eye height. Compare two sites, or one site on two
          dates, side by side.
        </p>
      </header>

      {tiles.length === 2 && (
        <div className="compare-bar">
          <span className="muted small">Comparing two sites</span>
          <button type="button" className="align-views" onClick={alignEyeLevels}>
            Align eye levels
          </button>
        </div>
      )}

      <div className={tiles.length > 1 ? 'tiles two' : 'tiles'}>
        {tiles.map((tile, i) => (
          <SiteTile
            key={tile.id}
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

      <div className="tile-actions">
        {tiles.length === 0 && (
          <button type="button" className="add-tile" onClick={addTile}>
            + Add a site
          </button>
        )}
        {tiles.length === 1 && (
          <button type="button" className="add-tile" onClick={addTile}>
            + Compare with another site
          </button>
        )}
      </div>

      <DistanceLegend />
    </main>
  )
}

/** How to read the views (shared by all tiles). */
function DistanceLegend() {
  const ticks = [0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200]
  return (
    <div className="distance-legend" aria-label="How to read the view">
      <div className="legend-block">
        <span className="legend-heading">Distance from you</span>
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
        hide terrain behind them) and distance contours (0.5, 1, 2, 5, 10 … km from you), all drawn the same way. Views
        are at true proportions. The Sun (yellow) and Earth (blue) are drawn at their true angular size; faded means
        hidden behind terrain. Hover anywhere for the exact distance and height.
      </p>
    </div>
  )
}

export default App

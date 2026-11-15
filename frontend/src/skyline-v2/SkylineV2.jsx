import { useRef, useState } from 'react'
import { fetchSiteTerrain } from './api.js'
import FirstPersonTerrain from './FirstPersonTerrain.jsx'
import OverheadTerrain from './OverheadTerrain.jsx'
import SiteInputForm from './SiteInputForm.jsx'

const VIEWS = [
  ['first-person', 'First-person 360°'],
  ['overhead', 'Overhead (orbit)'],
]

/**
 * Lunar Skyline V2 (developer page): one landing site at a time.
 *
 * Stage 0: inputs, the terrain request (POST /api/site/terrain) and a summary.
 * Stage 1: first-person shaded terrain with the local horizon, and an overhead elevation view.
 * Next:
 *   Stage 2  Sun and Earth on the skyline at the chosen instant (SPICE)
 *   Stage 3  shadow map;  Stage 4  power heatmap
 * Written as self-contained components so they can later move into Moon Explorer.
 */
export default function SkylineV2() {
  const [inputs, setInputs] = useState(null)
  const [terrain, setTerrain] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState('first-person')
  const inFlight = useRef(null)

  async function build(next) {
    if (terrain && next.lat === inputs.lat && next.lon === inputs.lon &&
        next.diameterKm === inputs.diameterKm && next.eyeHeightM === inputs.eyeHeightM &&
        next.elevationProduct === inputs.elevationProduct) {
      setInputs(next)
      return
    }
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setLoading(true)
    setError(null)
    const t0 = performance.now()
    try {
      const t = await fetchSiteTerrain(
        { lat: next.lat, lon: next.lon, diameterKm: next.diameterKm, observerHeightM: next.eyeHeightM,
          elevationProduct: next.elevationProduct },
        controller.signal,
      )
      if (inFlight.current === controller) {
        setInputs(next)
        setTerrain({ ...t, receivedMs: performance.now() - t0 })
      }
    } catch (err) {
      if (inFlight.current === controller && err.name !== 'AbortError') setError(err.message)
    } finally {
      if (inFlight.current === controller) setLoading(false)
    }
  }

  return (
    <main className="v2">
      <header className="v2-header">
        <a href="./" className="v2-back">← Menu</a>
        <h1>Lunar Skyline V2 <span className="v2-badge">developer</span></h1>
        <p className="v2-muted">
          Explore the landing site from ground level and see where nearby terrain and distant ridges meet the sky.
        </p>
      </header>

      <SiteInputForm onSubmit={build} loading={loading} />

      {loading && (
        <p className="v2-muted" role="status">Loading landing-site terrain and the 360° horizon…</p>
      )}
      {error && <p className="v2-error" role="alert">{error}</p>}

      {terrain && inputs && (
        <section className="v2-result">
          <div className="v2-tabs" role="tablist" aria-label="View">
            {VIEWS.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={view === key}
                className={view === key ? 'on' : undefined} onClick={() => setView(key)}>
                {label}
              </button>
            ))}
          </div>
          <div role="tabpanel">
            {view === 'first-person' ? (
              <>
                <FirstPersonTerrain key={`${inputs.lat},${inputs.lon},${inputs.eyeHeightM}`}
                  terrain={terrain} />
                <p className="v2-muted v2-note">
                  {terrain.header.elevation_maps?.length
                    ? `LOLA near to far · ${terrain.header.elevation_maps.join(' → ')}`
                    : 'LOLA LDEM_128 for the full view · 128 pixels per degree'}
                </p>
              </>
            ) : (
              <OverheadTerrain key={`${inputs.lat},${inputs.lon},${inputs.diameterKm}`} terrain={terrain} />
            )}
          </div>
          {view === 'overhead' && <p className="v2-muted v2-note">
            The amber line marks the {terrain.header.site.diameter_km} km landing-site boundary.
          </p>}
          <TerrainSummary terrain={terrain} inputs={inputs} />
        </section>
      )}
    </main>
  )
}

function TerrainSummary({ terrain, inputs }) {
  const { header, arrays } = terrain
  const { site, site_grid: grid, skyline } = header
  const bytes = Object.values(arrays).reduce((n, a) => n + a.byteLength, 0)
  const rows = [
    ['Site', `${inputs.siteName ?? 'Custom'} · ${site.lat.toFixed(4)}°, ${site.lon.toFixed(4)}°E`],
    ['Time (UTC)', `${inputs.timeUtc.replace('T', ' ').replace(':00Z', '')} (used from Stage 2; the terrain does not depend on it)`],
    ['Ground height', `${site.ground_m.toLocaleString()} m above the 1,737.4 km sphere`],
    ['Eye', `${site.eye_height_m} m above ground → ${site.eye_m.toLocaleString()} m`],
    ['Landing site', `${site.diameter_km} km across`],
    ['Site grid', `${grid.points} × ${grid.points} points, ${grid.spacing_m.toFixed(1)} m apart (${fmtMaps(grid.maps_used)})`],
    ['Local horizon', `${skyline.azimuth_step_deg}° bearing samples, terrain checked up to ${skyline.max_range_m / 1000} km away`],
    ['Data', `${(bytes / 1e6).toFixed(2)} MB decoded, received in ${(terrain.receivedMs / 1000).toFixed(2)} s`],
  ]
  return (
    <dl className="v2-summary">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function fmtMaps(used) {
  return Object.entries(used).map(([px, n]) => `${px} pixels: ${n.toLocaleString()} points`).join(', ')
}


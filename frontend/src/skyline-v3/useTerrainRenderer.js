import { useEffect, useMemo, useRef, useState } from 'react'
import { buildGeometry, createTerrainRenderer } from './terrainRenderer.js'

/**
 * A terrain renderer on canvasRef with the site geometry uploaded.
 * Returns { rendererRef, geometry, error }.
 */
export function useTerrainRenderer(canvasRef, terrain) {
  const rendererRef = useRef(null)
  const [error, setError] = useState(null)
  const geometry = useMemo(() => buildGeometry(terrain), [terrain])

  useEffect(() => {
    let renderer = null
    let problem = null
    try {
      renderer = createTerrainRenderer(canvasRef.current)
      if (!renderer) problem = 'This browser does not support WebGL2, which the terrain view needs.'
    } catch (err) {
      problem = err.message
    }
    rendererRef.current = renderer
    if (problem) queueMicrotask(() => setError(problem))
    return () => {
      renderer?.dispose()
      rendererRef.current = null
    }
  }, [canvasRef])

  useEffect(() => {
    rendererRef.current?.setGeometry(geometry)
  }, [geometry])

  return { rendererRef, geometry, error }
}

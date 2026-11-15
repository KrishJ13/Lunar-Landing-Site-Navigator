import { useEffect, useState } from 'react'

/** Width (CSS px) of the element in `ref`, kept up to date. */
export function useWidth(ref, initial = 800) {
  const [width, setWidth] = useState(initial)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.floor(entry.contentRect.width))))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** Size a canvas's backing store to width x height CSS px at the device pixel ratio. */
export function sizeCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(width * dpr)
  const h = Math.round(height * dpr)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  return dpr
}

import { useEffect, useState } from 'react'

export const SPEEDS = [1, 5, 20]
const BASE_TICK_MS = 1000 // one cached sample per second at 1x

/** Playback over an in-memory list of `count` samples: no network calls while playing. */
export function usePlayback(count) {
  const last = Math.max(0, count - 1)
  const [idx, setIdxRaw] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)

  const isPlaying = playing && idx < last // auto-stops at the final sample

  useEffect(() => {
    if (!isPlaying) return
    const id = setInterval(() => setIdxRaw((i) => Math.min(i + 1, last)), BASE_TICK_MS / speed)
    return () => clearInterval(id)
  }, [isPlaying, speed, last])

  return {
    idx: Math.min(idx, last),
    last,
    isPlaying,
    speed,
    setSpeed,
    reset() {
      setPlaying(false)
      setIdxRaw(0)
    },
    seek(i) {
      setPlaying(false)
      setIdxRaw(Math.max(0, Math.min(last, i)))
    },
    toggle() {
      if (isPlaying) return setPlaying(false)
      if (idx >= last) setIdxRaw(0)
      setPlaying(true)
    },
  }
}

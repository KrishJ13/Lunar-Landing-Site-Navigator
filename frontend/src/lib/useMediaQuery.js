import { useSyncExternalStore } from 'react'

/** Live `window.matchMedia(query).matches` (false where matchMedia is unavailable). */
export function useMediaQuery(query) {
  return useSyncExternalStore(
    (notify) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', notify)
      return () => mq.removeEventListener('change', notify)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

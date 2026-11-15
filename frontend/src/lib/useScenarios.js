import { useEffect, useState } from 'react'
import { loadScenarios } from './journey.js'

/** Saved scenarios A and B, kept in sync across components, pages and tabs. */
export default function useScenarios() {
  const [scenarios, setScenarios] = useState(loadScenarios)
  useEffect(() => {
    const refresh = () => setScenarios(loadScenarios())
    window.addEventListener('lunar-scenarios', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('lunar-scenarios', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])
  return scenarios
}

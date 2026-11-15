import { CALCULATIONS_URL } from '../lib/projectLinks.js'

export default function ProjectLinks() {
  return (
    <nav className="moon-project-links" aria-label="Project links">
      <a className="moon-project-link" href={CALCULATIONS_URL} target="_blank" rel="noreferrer">How we calculated things</a>
      <details className="moon-authors">
        <summary className="moon-project-link">Authors</summary>
        <ul>
          <li><a href="https://github.com/KrishJ13" target="_blank" rel="noreferrer">Krish Jain</a></li>
          <li><a href="https://github.com/PranayElligaram" target="_blank" rel="noreferrer">Pranay Elligaram</a></li>
        </ul>
      </details>
    </nav>
  )
}

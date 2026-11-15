import { MAP_DIRECTORY } from './globeShader.js'
import './explorer.css'

function Menu() {
  return (
    <main className="moon-menu">
      <div className="moon-menu-inner">
        <header>
          <h1>Lunar Landing Site Navigator</h1>
        </header>
        <nav aria-label="Lunar tools">
          <a className="moon-menu-card moon-menu-explorer" href="./moon.html">
            <div className="moon-menu-art" style={{ '--moon-map': `url("${MAP_DIRECTORY}moon.webp")` }} />
            <div className="moon-menu-card-text">
              <h2>Moon Explorer <span aria-hidden="true">↗</span></h2>
              <p>Pick landing sites on the Moon and explore or compare them in Skyline V3.</p>
            </div>
          </a>
        </nav>
      </div>
    </main>
  )
}

export default Menu

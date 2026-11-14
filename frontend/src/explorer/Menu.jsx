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
              <p>See the Moon at a specific date and time. Explore the near side and both poles.</p>
            </div>
          </a>
          <a className="moon-menu-card moon-menu-skyline" href={import.meta.env.VITE_LUNAR_SKYLINE_URL || './skyline.html'}>
            <div className="moon-menu-card-text">
              <h2>Lunar Skyline <span aria-hidden="true">↗</span></h2>
              <p>Stand on the lunar surface and compare the terrain and sky at two sites.</p>
            </div>
          </a>
        </nav>
      </div>
    </main>
  )
}

export default Menu

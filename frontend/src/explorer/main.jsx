import { createRoot } from 'react-dom/client'
import Menu from './Menu.jsx'
import MoonExplorer from './MoonExplorer.jsx'
import './explorer.css'

const root = document.getElementById('root')
// The app opens on the Moon Explorer; an archive of earlier pages is at ?tools (unlinked).
const tools = new URLSearchParams(window.location.search).has('tools')
createRoot(root).render(tools ? <Menu /> : <MoonExplorer />)

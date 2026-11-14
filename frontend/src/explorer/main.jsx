import { createRoot } from 'react-dom/client'
import Menu from './Menu.jsx'
import MoonExplorer from './MoonExplorer.jsx'
import './explorer.css'

const root = document.getElementById('root')
createRoot(root).render(root.dataset.page === 'moon' ? <MoonExplorer /> : <Menu />)

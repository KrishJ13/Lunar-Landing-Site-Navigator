import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import './skylineV3.css'
import SkylineV3 from './SkylineV3.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <SkylineV3 />
  </StrictMode>,
)

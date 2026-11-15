import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import './skylineV2.css'
import SkylineV2 from './SkylineV2.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <SkylineV2 />
  </StrictMode>,
)

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Forward /api/* to the Python backend during development, so the
    // frontend can use relative URLs and no CORS setup is needed.
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})

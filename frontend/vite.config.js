import process from 'node:process'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        menu: fileURLToPath(new URL('./index.html', import.meta.url)),
        moon: fileURLToPath(new URL('./moon.html', import.meta.url)),
        skyline: fileURLToPath(new URL('./skyline.html', import.meta.url)),
        skylineV2: fileURLToPath(new URL('./skyline-v2.html', import.meta.url)),
        skylineV3: fileURLToPath(new URL('./skyline-v3.html', import.meta.url)),
      },
    },
  },
  server: {
    proxy: {
      '/api': process.env.LUNAR_API_PROXY || 'http://127.0.0.1:8000',
    },
  },
})

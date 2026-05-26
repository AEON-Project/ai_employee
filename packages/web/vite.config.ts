import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:7878',
      '/ws': { target: 'ws://localhost:7878', ws: true },
      '/auth': 'http://localhost:7878',
      '/health': 'http://localhost:7878',
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
})

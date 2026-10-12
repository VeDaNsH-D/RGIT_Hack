import react from '@vitejs/plugin-react'
import process from 'node:process'
import { defineConfig, loadEnv } from 'vite'

const backendPort = process.env.VITE_BACKEND_PORT || process.env.BACKEND_PORT || 5001;
const apiTarget = process.env.VITE_API_TARGET || `http://localhost:${backendPort}`;

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const proxy = { '/api': { target: env.VITE_API_PROXY_TARGET || 'http://localhost:8000', changeOrigin: true } }
  return {
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
  }
})

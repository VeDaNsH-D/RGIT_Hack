import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backendPort = process.env.VITE_BACKEND_PORT || process.env.BACKEND_PORT || 5001;
const apiTarget = process.env.VITE_API_TARGET || `http://localhost:${backendPort}`;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})

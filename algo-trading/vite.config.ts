import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiBase = env.VITE_API_BASE ?? env.VITE_API_URL

  if (mode === 'production' && apiBase && !apiBase.startsWith('/')) {
    const parsedApiBase = new URL(apiBase)
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsedApiBase.hostname)
    if (parsedApiBase.protocol !== 'https:' && !isLoopback) {
      throw new Error('Production VITE_API_BASE must use HTTPS (HTTP is allowed only for loopback development).')
    }
  }

  return {
    plugins: [react()],
  }
})

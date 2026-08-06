import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // En desarrollo el panel corre en Vite y la API en Fastify: se proxean las
    // rutas del backend para que la cookie de sesión viaje en el mismo origen.
    proxy: {
      '/api': 'http://localhost:8080',
      '/t': 'http://localhost:8080',
    },
  },
})

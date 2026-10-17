import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    {
      // Serves the /api world-database endpoints in dev. The same handler backs
      // the production server (server/serve.mjs). Imported dynamically so
      // `vite build` never loads the pg driver.
      name: 'explanet-db-api',
      async configureServer(server) {
        const { apiHandler } = await import('./server/api.mjs')
        server.middlewares.use(apiHandler)
      },
    },
  ],
})

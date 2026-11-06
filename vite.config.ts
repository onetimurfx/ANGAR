import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

// SPA fallback for static hosts (GitHub Pages serves 404.html for unknown paths).
const spaFallback = () => {
  let outDir = 'dist'
  return {
    name: 'spa-404-fallback',
    apply: 'build' as const,
    configResolved(c: { build: { outDir: string } }) {
      outDir = c.build.outDir
    },
    closeBundle() {
      copyFileSync(resolve(outDir, 'index.html'), resolve(outDir, '404.html'))
    },
  }
}

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss(), spaFallback()],
  server: { host: true },
})

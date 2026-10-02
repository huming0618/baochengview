import { defineConfig } from 'vite'

// GitHub Pages: /baochengview/; Capacitor / offline: VITE_BASE=./
export default defineConfig({
  base: process.env.VITE_BASE || '/baochengview/',
  server: {
    port: 5847,
    host: '0.0.0.0'
  },
  preview: {
    port: 5847,
    host: '0.0.0.0'
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  }
})

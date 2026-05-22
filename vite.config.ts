import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'))
const buildInfo = JSON.parse(readFileSync('./build-info.json', 'utf-8'))
const buildDate = new Date(buildInfo.date).toLocaleDateString('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric'
})

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_NUMBER__: JSON.stringify(buildInfo.build),
    __BUILD_DATE__: JSON.stringify(buildDate)
  },
  root: 'src/renderer',
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true
  },
  server: {
    port: 5173
  }
})

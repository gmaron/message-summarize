import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/**
 * The web (RNF-19): Svelte 5 compiled by Vite, served by the daemon as static files from `dist/web`. The page runs under
 * a strict CSP (no inline script or style), so nothing here may inline code: the CSS goes to a file.
 */
export default defineConfig({
  root: here('./src/interfaces/web'),
  base: './',
  plugins: [svelte()],
  build: {
    outDir: here('./dist/web'),
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    reportCompressedSize: true,
  },
})

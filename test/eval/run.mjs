// `npm run eval:ollama -- --models a,b [--base-url URL] [--runs N] [--allow-remote]`
//
// The evaluation is TypeScript that imports the product code, so it is loaded through Vite (already a dev dependency,
// and what Vitest uses): no build step and no extra package. The Vite server runs in middleware mode, listens on no
// port and is closed before exiting; nothing is left running.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true },
})
let code = 1
try {
  const { runEval } = await server.ssrLoadModule('/test/eval/ollama-eval.ts')
  code = await runEval(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    today: () => new Date().toLocaleDateString('sv-SE'),
    resultsDir: join(here, 'ollama', 'results'),
  })
} finally {
  await server.close()
}
process.exit(code)

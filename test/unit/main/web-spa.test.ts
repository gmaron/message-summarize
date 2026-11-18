import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeHarnesses } from '../../support/cli-harness.js'
import { disposeWorlds, world } from '../../support/web-world.js'

const dirs: string[] = []
afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the single-page app served by the daemon (RF-71)', () => {
  it('serves the built index.html at / and its assets, under the CSP, with no token needed for the shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'msum-spa-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'assets'))
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><title>built page</title><script type="module" src="/assets/app.js"></script>',
    )
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
    const w = await world({ staticDir: dir })
    const page = await fetch(`http://127.0.0.1:${w.port}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(await page.text()).toContain('built page')
    const script = await fetch(`http://127.0.0.1:${w.port}/assets/app.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toContain('text/javascript')
  })

  it('answers 503 with the "not built" page while there is no build', async () => {
    const w = await world({ staticDir: join(tmpdir(), 'msum-does-not-exist') })
    expect((await fetch(`http://127.0.0.1:${w.port}/`)).status).toBe(503)
  })
})

describe('GET /api/info', () => {
  it('tells the language of the installation, behind the token', async () => {
    const w = await world()
    expect((await w.api('GET', '/api/info', undefined, null)).status).toBe(401)
    expect(await w.api('GET', '/api/info')).toEqual({ status: 200, body: { language: 'en' } })
  })
})

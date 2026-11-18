import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROMPT_MAX_LENGTH } from '../../../src/domain/prompt.js'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import { disposeHarnesses, FakeSummarizer, seedMessages, until } from '../../support/cli-harness.js'
import { BASE, disposeWorlds, type World, world } from '../../support/web-world.js'

afterEach(async () => {
  await disposeWorlds()
  disposeHarnesses()
})

const url = (id: string) => `/api/accounts/${id}/prompt`
const accountFile = (w: World, id: string) => w.h.accountOf(id).configFile
const promptFile = (w: World, id: string) => join(w.h.accountOf(id).dir, 'prompt.md')
const previousFile = (w: World, id: string) => join(w.h.accountOf(id).dir, 'prompt.previous.md')
const readAccount = (w: World, id: string) =>
  existsSync(accountFile(w, id))
    ? (JSON.parse(readFileSync(accountFile(w, id), 'utf8')) as Record<string, unknown>)
    : {}
const defaultEn = getCatalog('en').defaultSystemPrompt
const defaultEs = getCatalog('es').defaultSystemPrompt
const SECRET_PROMPT = 'PRIVATE-PROMPT-TEXT: always mention {{name}} first'

describe('GET /api/accounts/:id/prompt (RF-38)', () => {
  it('is behind the token and only for an account that exists', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect((await w.api('GET', url('alpha'), undefined, null)).status).toBe(401)
    expect((await w.api('PUT', url('alpha'), { text: 'x' }, null)).status).toBe(401)
    expect((await w.api('DELETE', url('alpha'), undefined, null)).status).toBe(401)
    for (const method of ['GET', 'PUT', 'DELETE']) {
      expect(await w.api(method, url('ghost'), method === 'PUT' ? { text: 'x' } : undefined)).toEqual({
        status: 404,
        body: { error: 'notFound' },
      })
      expect(
        (await w.api(method, '/api/accounts/..%2Fx/prompt', method === 'PUT' ? { text: 'x' } : undefined)).status,
      ).toBe(404)
    }
  })

  it('gives the built-in template of the language of the account, the variables and the limit', async () => {
    const w = await world({ accounts: ['alpha', 'beta'], config: { ...BASE, ownerName: 'Marta Prueba' } })
    writeFileSync(accountFile(w, 'beta'), JSON.stringify({ language: 'es' }))
    const alpha = await w.api('GET', url('alpha'))
    expect(alpha).toEqual({
      status: 200,
      body: {
        source: 'default',
        text: defaultEn,
        defaultText: defaultEn,
        variables: ['{{name}}'],
        maxLength: PROMPT_MAX_LENGTH,
        ownerName: 'Marta Prueba',
      },
    })
    const beta = await w.api('GET', url('beta'))
    expect(beta.body).toMatchObject({ source: 'default', text: defaultEs, defaultText: defaultEs })
  })

  it('says where a custom prompt comes from: the account, or the installation', async () => {
    const w = await world({ accounts: ['alpha', 'beta'] })
    writeFileSync(join(w.h.layout.dataDir, 'shared.md'), 'installation text {{name}}')
    writeFileSync(w.h.layout.configFile, JSON.stringify({ ...BASE, promptFile: 'shared.md' }))
    writeFileSync(promptFile(w, 'beta'), 'beta own text')
    writeFileSync(accountFile(w, 'beta'), JSON.stringify({ promptFile: 'prompt.md' }))
    const alpha = await w.api('GET', url('alpha'))
    expect(alpha.body).toMatchObject({
      source: 'installation',
      text: 'installation text {{name}}',
      defaultText: defaultEn,
    })
    expect(alpha.body.error).toBeUndefined()
    expect((await w.api('GET', url('beta'))).body).toMatchObject({ source: 'account', text: 'beta own text' })
  })

  it('reports a promptFile that cannot be read and offers the built-in text to start from', async () => {
    const w = await world({ accounts: ['alpha'] })
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ promptFile: 'gone.md' }))
    const reply = await w.api('GET', url('alpha'))
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ source: 'account', error: 'promptFile', text: defaultEn })
  })

  it('answers 422 invalidConfig when the configuration is not valid', async () => {
    const w = await world({ accounts: ['alpha'] })
    writeFileSync(accountFile(w, 'alpha'), '{ not json')
    const reply = await w.api('GET', url('alpha'))
    expect(reply.status).toBe(422)
    expect(reply.body.error).toBe('invalidConfig')
  })
})

describe('PUT /api/accounts/:id/prompt', () => {
  it('writes accounts/<id>/prompt.md (mode 0600) and sets promptFile in the ACCOUNT config only', async () => {
    const w = await world({ accounts: ['alpha', 'beta'] })
    const rootBefore = readFileSync(w.h.layout.configFile, 'utf8')
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ unreadOnly: true }))
    const reply = await w.api('PUT', url('alpha'), { text: SECRET_PROMPT })
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ source: 'account', text: SECRET_PROMPT, defaultText: defaultEn })
    expect(readFileSync(promptFile(w, 'alpha'), 'utf8')).toBe(SECRET_PROMPT)
    if (process.platform !== 'win32') expect(lstatSync(promptFile(w, 'alpha')).mode & 0o777).toBe(0o600)
    expect(readAccount(w, 'alpha')).toEqual({ unreadOnly: true, promptFile: 'prompt.md' })
    expect(readFileSync(w.h.layout.configFile, 'utf8')).toBe(rootBefore)
    // another account is untouched, and no temporary file is left behind
    expect(existsSync(promptFile(w, 'beta'))).toBe(false)
    expect((await w.api('GET', url('beta'))).body.source).toBe('default')
    expect(readdirSync(w.h.accountOf('alpha').dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    // the same as a fresh GET; and the generic settings API still refuses the option
    expect((await w.api('GET', url('alpha'))).body).toEqual(reply.body)
    expect((await w.api('PUT', `/api/accounts/alpha/settings`, { promptFile: 'x.md' })).status).toBe(400)
  })

  it('rewrites the file when the account already points to its own prompt.md, leaving the config as it is', async () => {
    const w = await world({ accounts: ['alpha'] })
    writeFileSync(promptFile(w, 'alpha'), 'old')
    writeFileSync(accountFile(w, 'alpha'), '{"promptFile":"./prompt.md","language":"es"}\n')
    const before = readFileSync(accountFile(w, 'alpha'), 'utf8')
    expect((await w.api('PUT', url('alpha'), { text: 'new text' })).status).toBe(200)
    expect(readFileSync(promptFile(w, 'alpha'), 'utf8')).toBe('new text')
    expect(readFileSync(accountFile(w, 'alpha'), 'utf8')).toBe(before)
  })

  it('points the account at its own file when it used another one, which is left alone', async () => {
    const w = await world({ accounts: ['alpha'] })
    const elsewhere = join(w.h.layout.dataDir, 'elsewhere.md')
    writeFileSync(elsewhere, 'elsewhere text')
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ promptFile: elsewhere }))
    expect((await w.api('PUT', url('alpha'), { text: 'mine' })).status).toBe(200)
    expect(readAccount(w, 'alpha').promptFile).toBe('prompt.md')
    expect(readFileSync(elsewhere, 'utf8')).toBe('elsewhere text')
  })

  it('refuses a body that is not { text: string } (400), and a blank, too long or unknown-variable prompt (422)', async () => {
    const w = await world({ accounts: ['alpha'] })
    for (const body of [undefined, null, [], 'x', {}, { text: 1 }, { text: null }]) {
      expect(await w.api('PUT', url('alpha'), body)).toEqual({ status: 400, body: { error: 'invalidRequest' } })
    }
    for (const text of ['', '   \n\t', '<!-- only a note -->\n']) {
      expect(await w.api('PUT', url('alpha'), { text })).toEqual({ status: 422, body: { error: 'blankPrompt' } })
    }
    expect(await w.api('PUT', url('alpha'), { text: 'x'.repeat(PROMPT_MAX_LENGTH + 1) })).toEqual({
      status: 422,
      body: { error: 'promptTooLong', maxLength: PROMPT_MAX_LENGTH },
    })
    expect(await w.api('PUT', url('alpha'), { text: `a {{name}} b {{ name }} {{owner}} {{owner}}` })).toEqual({
      status: 422,
      body: { error: 'unknownVariable', variables: ['{{ name }}', '{{owner}}'] },
    })
    // exactly the limit is fine, and so is a text with no variable at all
    expect((await w.api('PUT', url('alpha'), { text: 'x'.repeat(PROMPT_MAX_LENGTH) })).status).toBe(200)
    // nothing was written by the refused ones: the file is the last good one
    expect(readFileSync(promptFile(w, 'alpha'), 'utf8')).toHaveLength(PROMPT_MAX_LENGTH)
  })

  it('does not overwrite an unreferenced prompt.md when the config change would be refused', async () => {
    const w = await world({ accounts: ['alpha'] })
    writeFileSync(promptFile(w, 'alpha'), 'leftover nobody points at')
    // a value of the wrong type makes any change of this account's config invalid
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ unreadOnly: 'yes' }))
    const reply = await w.api('PUT', url('alpha'), { text: 'new text' })
    expect(reply.status).toBe(422)
    expect(reply.body.error).toBe('invalidConfig')
    expect(readFileSync(promptFile(w, 'alpha'), 'utf8')).toBe('leftover nobody points at')
    expect(readAccount(w, 'alpha')).toEqual({ unreadOnly: 'yes' })
  })

  it('accepts placeholders inside comments, which the renderer strips', async () => {
    const w = await world({ accounts: ['alpha'] })
    const text = 'Write for {{name}}. <!-- note: {{owner}} is not a variable -->'
    expect((await w.api('PUT', url('alpha'), { text })).status).toBe(200)
    expect(readFileSync(promptFile(w, 'alpha'), 'utf8')).toBe(text)
    expect((await w.api('PUT', url('alpha'), { text: 'Write {{owner}} <!-- {{name}} -->' })).status).toBe(422)
  })

  it('writes nothing when it is refused', async () => {
    const w = await world({ accounts: ['alpha'] })
    await w.api('PUT', url('alpha'), { text: '{{nope}}' })
    await w.api('PUT', url('alpha'), { text: ' ' })
    expect(existsSync(promptFile(w, 'alpha'))).toBe(false)
    expect(existsSync(accountFile(w, 'alpha')) ? readAccount(w, 'alpha') : {}).toEqual({})
  })

  it('does not touch a config that is not valid JSON (422 invalidConfig)', async () => {
    const w = await world({ accounts: ['alpha'] })
    writeFileSync(accountFile(w, 'alpha'), '{ hand edited')
    const reply = await w.api('PUT', url('alpha'), { text: 'fine' })
    expect(reply.status).toBe(422)
    expect(reply.body.error).toBe('invalidConfig')
    expect(readFileSync(accountFile(w, 'alpha'), 'utf8')).toBe('{ hand edited')
    expect(existsSync(promptFile(w, 'alpha'))).toBe(false)
  })

  it('never writes through a link at prompt.md: the target outside the account is untouched', async () => {
    if (process.platform === 'win32') return
    const w = await world({ accounts: ['alpha'] })
    const outside = join(w.h.layout.dataDir, 'outside.txt')
    writeFileSync(outside, 'do not touch')
    symlinkSync(outside, promptFile(w, 'alpha'))
    expect((await w.api('PUT', url('alpha'), { text: 'through the link?' })).status).toBe(200)
    expect(readFileSync(outside, 'utf8')).toBe('do not touch')
    expect(lstatSync(promptFile(w, 'alpha')).isSymbolicLink()).toBe(false)
    expect(readFileSync(promptFile(w, 'alpha'), 'utf8')).toBe('through the link?')
  })

  it('refuses an account whose directory is a link', async () => {
    if (process.platform === 'win32') return
    const w = await world({ accounts: ['alpha'] })
    const dir = w.h.accountOf('alpha').dir
    const moved = `${dir}-real`
    const { renameSync, rmSync } = await import('node:fs')
    renameSync(dir, moved)
    symlinkSync(moved, dir)
    try {
      expect((await w.api('PUT', url('alpha'), { text: 'x' })).status).toBe(500)
      expect((await w.api('DELETE', url('alpha'))).status).toBe(500)
      expect(existsSync(join(moved, 'prompt.md'))).toBe(false)
    } finally {
      rmSync(dir, { force: true })
      renameSync(moved, dir)
    }
  })

  it('is applied by the next preview: the summarizer receives the new prompt, with {{name}} replaced', async () => {
    const summarizer = new FakeSummarizer()
    const w = await world({
      accounts: ['alpha'],
      linked: ['alpha'],
      summarizer,
      config: { ...BASE, ownerName: 'Marta Prueba' },
    })
    const runtime = w.h.runtime('alpha')
    try {
      await seedMessages(runtime, [{ id: 'm1', text: 'dinner on friday', timestamp: Date.now() - 3_600_000 }])
    } finally {
      runtime.close()
    }
    await until(() => w.host.daemonOf('alpha') !== undefined, 'the unit')
    const preview = async (count: number) => {
      expect((await w.api('POST', '/api/accounts/alpha/preview')).status).toBe(202)
      await until(() => w.eventsOf('preview').length === count, `preview ${count}`)
    }
    await preview(1)
    expect(summarizer.requests.at(-1)?.systemPrompt).toContain('Marta Prueba')
    expect(summarizer.requests.at(-1)?.systemPrompt).not.toContain('PROMPT-MARKER')

    const text = 'PROMPT-MARKER: write for {{name}}. <!-- note for the editor -->'
    expect((await w.api('PUT', url('alpha'), { text })).status).toBe(200)
    await preview(2)
    expect(summarizer.requests.at(-1)?.systemPrompt).toBe('PROMPT-MARKER: write for Marta Prueba.')

    // editing only the file's content (same option) also applies to the very next one
    expect((await w.api('PUT', url('alpha'), { text: 'SECOND-MARKER' })).status).toBe(200)
    await preview(3)
    expect(summarizer.requests.at(-1)?.systemPrompt).toBe('SECOND-MARKER')

    // the output format is not part of what the user edits: no schema text in the prompt
    expect(summarizer.requests.at(-1)?.systemPrompt).not.toContain('json')

    // back to the original
    expect((await w.api('DELETE', url('alpha'))).status).toBe(200)
    await preview(4)
    const last = summarizer.requests.at(-1)?.systemPrompt ?? ''
    expect(last).toContain('Marta Prueba')
    expect(last).not.toContain('SECOND-MARKER')
  })

  it('never logs or publishes the text of the prompt', async () => {
    const w = await world({ accounts: ['alpha'] })
    expect((await w.api('PUT', url('alpha'), { text: SECRET_PROMPT })).status).toBe(200)
    expect((await w.api('PUT', url('alpha'), { text: '{{PRIVATE-PROMPT-TEXT}}' })).status).toBe(422)
    const logs = w.h.logs.join('\n')
    expect(logs).toContain('"event":"prompt.saved"')
    expect(logs).not.toContain('PRIVATE-PROMPT-TEXT')
    expect(JSON.stringify(w.sse)).not.toContain('PRIVATE-PROMPT-TEXT')
  })
})

describe('DELETE /api/accounts/:id/prompt (restore the original)', () => {
  it('removes promptFile and deletes the account prompt.md, and answers the new GET', async () => {
    const w = await world({ accounts: ['alpha'] })
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ unreadOnly: true }))
    await w.api('PUT', url('alpha'), { text: 'custom' })
    const reply = await w.api('DELETE', url('alpha'))
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ source: 'default', text: defaultEn })
    expect(existsSync(promptFile(w, 'alpha'))).toBe(false)
    expect(readAccount(w, 'alpha')).toEqual({ unreadOnly: true })
    expect((await w.api('GET', url('alpha'))).body).toEqual(reply.body)
    // idempotent
    expect((await w.api('DELETE', url('alpha'))).body).toEqual(reply.body)
  })

  it('also restores an account whose promptFile cannot be read', async () => {
    const w = await world({ accounts: ['alpha'] })
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ promptFile: 'gone.md' }))
    const reply = await w.api('DELETE', url('alpha'))
    expect(reply.body.error).toBeUndefined()
    expect(reply.body.source).toBe('default')
    expect(readAccount(w, 'alpha')).toEqual({})
  })

  it('lets the account inherit the installation promptFile again', async () => {
    const w = await world({ accounts: ['alpha'] })
    writeFileSync(join(w.h.layout.dataDir, 'shared.md'), 'shared text')
    writeFileSync(w.h.layout.configFile, JSON.stringify({ ...BASE, promptFile: 'shared.md' }))
    await w.api('PUT', url('alpha'), { text: 'account text' })
    expect((await w.api('GET', url('alpha'))).body).toMatchObject({ source: 'account', text: 'account text' })
    const reply = await w.api('DELETE', url('alpha'))
    expect(reply.body).toMatchObject({ source: 'installation', text: 'shared text' })
    expect(existsSync(promptFile(w, 'alpha'))).toBe(false)
    expect(readFileSync(join(w.h.layout.dataDir, 'shared.md'), 'utf8')).toBe('shared text')
  })

  it('deletes only the account prompt.md: a prompt kept elsewhere, or a leftover nobody points at, stays', async () => {
    const w = await world({ accounts: ['alpha', 'beta'] })
    const elsewhere = join(w.h.layout.dataDir, 'mine.md')
    writeFileSync(elsewhere, 'mine')
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ promptFile: '../../mine.md' }))
    writeFileSync(promptFile(w, 'alpha'), 'leftover')
    expect((await w.api('DELETE', url('alpha'))).status).toBe(200)
    expect(readFileSync(elsewhere, 'utf8')).toBe('mine')
    expect(readFileSync(promptFile(w, 'alpha'), 'utf8')).toBe('leftover')
    expect(readAccount(w, 'alpha')).toEqual({})
    // beta has no promptFile at all: nothing is removed even if the file is there
    writeFileSync(promptFile(w, 'beta'), 'beta leftover')
    expect((await w.api('DELETE', url('beta'))).status).toBe(200)
    expect(readFileSync(promptFile(w, 'beta'), 'utf8')).toBe('beta leftover')
  })

  it('a link at prompt.md is removed, never its target', async () => {
    if (process.platform === 'win32') return
    const w = await world({ accounts: ['alpha'] })
    const outside = join(w.h.layout.dataDir, 'outside.txt')
    writeFileSync(outside, 'keep me')
    mkdirSync(w.h.accountOf('alpha').dir, { recursive: true })
    symlinkSync(outside, promptFile(w, 'alpha'))
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ promptFile: 'prompt.md' }))
    expect((await w.api('DELETE', url('alpha'))).status).toBe(200)
    expect(readFileSync(outside, 'utf8')).toBe('keep me')
    expect(existsSync(promptFile(w, 'alpha'))).toBe(false)
    // the link was moved as a link: its target was not followed (no chmod, no copy)
    expect(lstatSync(previousFile(w, 'alpha')).isSymbolicLink()).toBe(true)
  })

  it('keeps the text: an imported-style prompt.md is moved to prompt.previous.md (0600), replacing an older one', async () => {
    const w = await world({ accounts: ['alpha'] })
    // what `msum import` leaves: prompt.md with its option, written with a looser mode
    writeFileSync(promptFile(w, 'alpha'), 'imported prompt for {{name}}', { mode: 0o644 })
    writeFileSync(previousFile(w, 'alpha'), 'an older copy')
    writeFileSync(accountFile(w, 'alpha'), JSON.stringify({ promptFile: 'prompt.md' }))
    const reply = await w.api('DELETE', url('alpha'))
    expect(reply.body).toMatchObject({ source: 'default', text: defaultEn })
    expect(existsSync(promptFile(w, 'alpha'))).toBe(false)
    expect(readFileSync(previousFile(w, 'alpha'), 'utf8')).toBe('imported prompt for {{name}}')
    if (process.platform !== 'win32') expect(lstatSync(previousFile(w, 'alpha')).mode & 0o777).toBe(0o600)
    // a later save and restore replaces it again
    await w.api('PUT', url('alpha'), { text: 'second' })
    await w.api('DELETE', url('alpha'))
    expect(readFileSync(previousFile(w, 'alpha'), 'utf8')).toBe('second')
  })

  it('stops the unit reading the file BEFORE it is moved', async () => {
    const w = await world({ accounts: ['alpha'] })
    await w.api('PUT', url('alpha'), { text: 'custom' })
    const seen: boolean[] = []
    const original = w.host.reloadConfig.bind(w.host)
    w.host.reloadConfig = async (id: string) => {
      seen.push(existsSync(promptFile(w, id)))
      await original(id)
    }
    expect((await w.api('DELETE', url('alpha'))).status).toBe(200)
    expect(seen).toEqual([true])
    expect(existsSync(previousFile(w, 'alpha'))).toBe(true)
  })
})

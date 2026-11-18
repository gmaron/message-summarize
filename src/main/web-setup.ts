import { DEFAULT_ACCOUNT_ID, isValidAccountId } from '../domain/account-id.js'
import {
  CONSENT_TEXT_VERSION,
  consentKeyFor,
  isEarlier,
  isSetupStep,
  nextStep,
  providerNeedsConsent,
  type SetupStep,
  stepIndex,
} from '../domain/setup.js'
import { LANGUAGES, type Language } from '../infrastructure/i18n/index.js'
import type { SetupRecord } from '../infrastructure/persistence/sqlite/index.js'
import { HttpError, type Route, type RouteResult } from '../interfaces/http/router.js'
import { type AppConfig, DEFAULT_LANGUAGE, isObject, PROVIDERS, type ProviderKind, readConfigObject } from './config.js'
import {
  serialized,
  type UpdateAccountConfigResult,
  updateAccountConfig,
  updateInstallationLanguage,
} from './config-writer.js'
import { type CommandContext, hasSession } from './context.js'
import { accountLayoutOf, unsafeAccountPath } from './paths.js'
import { TEST_TIMEOUT_MS, testProvider } from './provider-test.js'
import { type AccountRoutesSource, knownAccount } from './web-routes.js'
import { issueViews } from './web-settings.js'

export interface SetupRoutesSource extends AccountRoutesSource {
  readonly ctx: Pick<CommandContext, 'layout' | 'env' | 'web' | 'clock'>
  /** Creates an account as `POST /api/accounts` does (same checks). */
  readonly create: (id: string) => Promise<void>
  /** Told when something an account card shows changed (its settings), so the page hears of it. */
  readonly onChanged: () => void
}

/** `GET /api/setup` and what each change of it answers. Codes and ids only: nothing the user typed except their id. */
export interface SetupView {
  /** True when the wizard is over, skipped, or was never needed (the installation already had a linked account). */
  readonly completed: boolean
  readonly step: SetupStep
  /** The account the wizard is setting up, once the "name" step made it. */
  readonly account: string | null
  /** The account has a registered session (the "link" step can continue). */
  readonly linked: boolean
  /** The language of the installation as the first step left it. */
  readonly language: Language
  /** The external providers the account agreed to (RNF-02). */
  readonly consents: readonly string[]
}

const OWNER_NAME_MAX = 80

const object = (body: unknown): Record<string, unknown> => {
  if (!isObject(body)) throw new HttpError(400, 'invalidRequest')
  return body
}

/** The `provider` and `options` of a body (a test, or the provider step): the types are checked here, the values by the configuration. */
function readProvider(body: Record<string, unknown>): {
  provider: ProviderKind
  patch: Record<string, unknown>
} {
  const { provider, options } = body
  if (typeof provider !== 'string' || !(PROVIDERS as readonly string[]).includes(provider)) {
    throw new HttpError(400, 'invalidRequest')
  }
  if (options !== undefined && !isObject(options)) throw new HttpError(400, 'invalidRequest')
  const given = (options ?? {}) as Record<string, unknown>
  const text = (key: string): string | undefined => {
    const value = given[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new HttpError(400, 'invalidRequest')
    return value.trim() === '' ? undefined : value.trim()
  }
  const patch: Record<string, unknown> = { 'provider.primary': provider }
  const model = text('model')
  if (provider === 'claude-cli') {
    if (model !== undefined) patch['provider.claudeCli.model'] = model
  } else {
    const baseUrl = text('baseUrl')
    if (baseUrl !== undefined) patch['provider.ollama.baseUrl'] = baseUrl
    if (model !== undefined) patch['provider.ollama.model'] = model
  }
  return { provider: provider as ProviderKind, patch }
}

/**
 * The first-use wizard (RF-70) and the consent to external providers (RNF-02).
 *
 * The state is in `app.db`, so a wizard closed halfway (or a daemon restarted) resumes where it was left. `GET /api/setup`
 * says where; `PUT /api/setup` saves the step the user is on and moves to the next (`{ from, ...data }`), or goes back
 * (`{ goto }`); `POST /api/setup/skip` ends it. An installation that already has a linked account when the page first
 * asks is completed without a question (never nag who already set it up by the CLI or by `msum import`).
 *
 * This is the one place where the web writes the installation's config.json, and only its `language` (the installation's
 * language drives the texts of the web and of the command line, and there is no other account yet to hold it). Everything
 * else goes into the account's own file, as the settings do.
 *
 * `POST /api/setup/test-provider` makes the real call of RF-41 with a made-up chat, one at a time, only when asked.
 */
export function setupRoutes(source: SetupRoutesSource): Route[] {
  const { ctx, installation, host, create, onChanged } = source
  const { setup } = installation
  let testing = false

  const linkedOf = (id: string): Promise<boolean> => hasSession(accountLayoutOf(ctx.layout, id))

  /** The stored state, created at the first look. A missing account (deleted meanwhile) takes the wizard back to its step. */
  const current = async (): Promise<SetupRecord> => {
    let record = setup.get()
    if (record === null) {
      let linked = false
      for (const row of installation.accounts()) {
        if (await linkedOf(row.id)) {
          linked = true
          break
        }
      }
      record = setup.ensure(linked)
    }
    if (record.completedAt === null) {
      const known = record.account !== null && installation.accounts().some((row) => row.id === record?.account)
      if (!known && (record.account !== null || stepIndex(record.step) > stepIndex('name'))) {
        const step = stepIndex(record.step) > stepIndex('name') ? 'name' : record.step
        setup.save(step, null)
        record = setup.get() ?? record
      }
    }
    return record
  }

  const languageOf = async (): Promise<Language> => {
    const root = await readConfigObject(ctx.layout.configFile)
    const language = root.ok ? root.value.language : undefined
    return (LANGUAGES as readonly unknown[]).includes(language) ? (language as Language) : DEFAULT_LANGUAGE
  }

  const view = async (record?: SetupRecord): Promise<SetupView> => {
    const stored = record ?? (await current())
    const account = stored.account
    return {
      completed: stored.completedAt !== null,
      step: stored.step,
      account,
      linked: account === null ? false : await linkedOf(account),
      language: await languageOf(),
      consents:
        account === null
          ? []
          : setup
              .consents(account)
              .filter((consent) => consent.textVersion >= CONSENT_TEXT_VERSION)
              .map((consent) => consent.provider),
    }
  }

  /** Writes into the account's own file, or says why not as the settings do. Null when written. */
  const writeAccount = async (
    id: string,
    patch: Record<string, unknown>,
    dryRun = false,
  ): Promise<RouteResult | null> => {
    const account = accountLayoutOf(ctx.layout, id)
    if ((await unsafeAccountPath(account)) !== null) throw new HttpError(500, 'internal')
    const written: UpdateAccountConfigResult = await updateAccountConfig({
      rootFile: ctx.layout.configFile,
      accountFile: account.configFile,
      patch,
      dryRun,
    })
    if (written.ok) return null
    if (written.error.some((issue) => issue.code === 'concurrentEdit')) throw new HttpError(409, 'concurrentEdit')
    return { status: 422, body: { error: 'invalidConfig', issues: issueViews(written.error) } }
  }

  /** The configuration the account would have with `patch`, validated as a save would, without saving it. */
  const resolveConfig = async (
    id: string,
    patch: Record<string, unknown>,
  ): Promise<{ ok: true; config: AppConfig } | { ok: false; result: RouteResult }> => {
    const account = accountLayoutOf(ctx.layout, id)
    if ((await unsafeAccountPath(account)) !== null) throw new HttpError(500, 'internal')
    const resolved = await updateAccountConfig({
      rootFile: ctx.layout.configFile,
      accountFile: account.configFile,
      patch,
      dryRun: true,
    })
    if (resolved.ok) return { ok: true, config: resolved.value }
    if (resolved.error.some((issue) => issue.code === 'concurrentEdit')) throw new HttpError(409, 'concurrentEdit')
    return { ok: false, result: { status: 422, body: { error: 'invalidConfig', issues: issueViews(resolved.error) } } }
  }

  const advance = async (to: SetupStep, account: string | null): Promise<RouteResult> => {
    setup.save(to, account)
    return { body: await view() }
  }

  const stepLanguage = async (body: Record<string, unknown>, record: SetupRecord): Promise<RouteResult> => {
    if (typeof body.language !== 'string') throw new HttpError(400, 'invalidRequest')
    const written = await updateInstallationLanguage({
      rootFile: ctx.layout.configFile,
      language: body.language as Language,
    })
    if (!written.ok) {
      if (written.error.some((issue) => issue.code === 'concurrentEdit')) throw new HttpError(409, 'concurrentEdit')
      return { status: 422, body: { error: 'invalidConfig', issues: issueViews(written.error) } }
    }
    onChanged()
    return advance('name', record.account)
  }

  const stepName = async (body: Record<string, unknown>, record: SetupRecord): Promise<RouteResult> => {
    const ownerName = typeof body.ownerName === 'string' ? body.ownerName.trim() : ''
    if (ownerName === '' || ownerName.length > OWNER_NAME_MAX) throw new HttpError(400, 'invalidRequest')
    let id = record.account
    if (id === null) {
      const given = body.accountId ?? DEFAULT_ACCOUNT_ID
      if (typeof given !== 'string') throw new HttpError(400, 'invalidRequest')
      if (!isValidAccountId(given)) throw new HttpError(400, 'invalidAccountId')
      if (installation.accounts().some((row) => row.id === given)) {
        // An account made by the command line and not linked yet is adopted; one that is linked is not the wizard's.
        if (host.onlyAccountId !== null && host.onlyAccountId !== given) throw new HttpError(422, 'restricted')
        if (await linkedOf(given)) throw new HttpError(409, 'accountExists')
      } else await create(given)
      id = given
    } else if (body.accountId !== undefined && body.accountId !== id) {
      throw new HttpError(400, 'invalidRequest')
    }
    const failed = await writeAccount(id, { ownerName })
    if (failed !== null) return failed
    await host.reloadConfig(id)
    onChanged()
    return advance('provider', id)
  }

  const stepProvider = async (body: Record<string, unknown>, record: SetupRecord): Promise<RouteResult> => {
    const id = record.account
    if (id === null) throw new HttpError(409, 'wrongStep')
    const { provider, patch } = readProvider(body)
    // Validated first (and resolved: the address of Ollama decides who receives the text), so a consent is not recorded
    // for a choice that cannot be saved.
    const resolved = await resolveConfig(id, patch)
    if (!resolved.ok) return resolved.result
    const key = consentKeyFor(provider, resolved.config.provider.ollama.baseUrl)
    const agreed = key === null || setup.hasConsent(id, key, CONSENT_TEXT_VERSION)
    if (key !== null && !agreed && body.consent !== true) {
      return { status: 409, body: { error: 'consentRequired', provider: key } }
    }
    if (key !== null && !agreed) setup.recordConsent(id, key, CONSENT_TEXT_VERSION)
    const failed = await writeAccount(id, patch)
    if (failed !== null) return failed
    await host.reloadConfig(id)
    onChanged()
    return advance('transcription', id)
  }

  const stepLink = async (record: SetupRecord): Promise<RouteResult> => {
    if (record.account === null || !(await linkedOf(record.account))) throw new HttpError(409, 'notLinked')
    return advance('schedule', record.account)
  }

  return [
    { method: 'GET', path: '/api/setup', handler: async () => ({ body: await view() }) },
    {
      method: 'PUT',
      path: '/api/setup',
      handler: ({ body }) =>
        serialized('setup', async () => {
          const data = object(body)
          const record = await current()
          if (record.completedAt !== null) throw new HttpError(409, 'setupCompleted')
          if (data.goto !== undefined) {
            if (!isSetupStep(data.goto) || !isEarlier(data.goto, record.step))
              throw new HttpError(400, 'invalidRequest')
            return advance(data.goto, record.account)
          }
          if (!isSetupStep(data.from)) throw new HttpError(400, 'invalidRequest')
          if (data.from !== record.step) throw new HttpError(409, 'wrongStep')
          switch (record.step) {
            case 'language':
              return stepLanguage(data, record)
            case 'name':
              return stepName(data, record)
            case 'provider':
              return stepProvider(data, record)
            case 'link':
              return stepLink(record)
            case 'done':
              setup.complete()
              return { body: await view() }
            default:
              // transcription (nothing to save yet) and schedule (the schedules are added through their own routes)
              return advance(nextStep(record.step) as SetupStep, record.account)
          }
        }),
    },
    {
      method: 'POST',
      path: '/api/setup/skip',
      handler: () =>
        serialized('setup', async () => {
          await current()
          setup.complete()
          return { body: await view() }
        }),
    },
    {
      method: 'POST',
      path: '/api/setup/test-provider',
      handler: async ({ body }) => {
        const data = object(body)
        const { provider, patch } = readProvider(data)
        if (testing) throw new HttpError(409, 'testRunning')
        testing = true
        try {
          const id = (await current()).account
          if (id === null) throw new HttpError(409, 'wrongStep')
          // The configuration the account would have with this choice, validated as a save would, without saving it.
          // `baseUrl` is a destination the user declares themselves (RNF-01): the test contacts only that address, and a
          // non-loopback one needs the same consent as a save (its host receives the made-up chat).
          const resolved = await resolveConfig(id, patch)
          if (!resolved.ok) return resolved.result
          const config = resolved.config
          // The text of the test goes to the recipient: only with the consent given (ticked or recorded).
          const key = consentKeyFor(provider, config.provider.ollama.baseUrl)
          if (key !== null && data.consent !== true && !setup.hasConsent(id, key, CONSENT_TEXT_VERSION)) {
            return { status: 409, body: { error: 'consentRequired', provider: key } }
          }
          const limit = Math.min(ctx.web?.providerTestTimeoutMs ?? TEST_TIMEOUT_MS[provider], TEST_TIMEOUT_MS[provider])
          const tested = await testProvider(
            {
              ...config,
              provider: {
                ...config.provider,
                claudeCli: {
                  ...config.provider.claudeCli,
                  timeoutMs: Math.min(config.provider.claudeCli.timeoutMs, limit),
                },
                ollama: { ...config.provider.ollama, timeoutMs: Math.min(config.provider.ollama.timeoutMs, limit) },
              },
            },
            ctx.env,
          )
          return { body: tested }
        } finally {
          testing = false
        }
      },
    },
    {
      method: 'POST',
      path: '/api/accounts/:id/consents',
      handler: ({ params, body }) => {
        const id = knownAccount(source, params)
        const { provider } = object(body)
        if (typeof provider !== 'string' || !providerNeedsConsent(provider)) throw new HttpError(400, 'invalidRequest')
        setup.recordConsent(id, provider, CONSENT_TEXT_VERSION)
        return { status: 201, body: { provider, textVersion: CONSENT_TEXT_VERSION } }
      },
    },
  ]
}

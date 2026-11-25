import { DEFAULT_ACCOUNT_ID, isValidAccountId } from '../../domain/account-id.js'
import { ALL_WEEKDAYS, makeSchedule } from '../../domain/schedule.js'
import {
  CONSENT_TEXT_VERSION,
  consentKeyFor,
  DEFAULT_SCHEDULE_TIMES,
  EXTERNAL_PROVIDERS,
  isEarlier,
  isSetupStep,
  OLLAMA_REMOTE,
  providerNeedsConsent,
  type SetupStep,
  stepIndex,
} from '../../domain/setup.js'
import { LANGUAGES, type Language } from '../../infrastructure/i18n/index.js'
import { isOpenAiHost, OPENAI_BASE_URL } from '../../infrastructure/llm/index.js'
import type { SetupRecord } from '../../infrastructure/persistence/sqlite/index.js'
import { isValidTimezone } from '../../infrastructure/scheduling/croner-scheduler.js'
import { envNames, type KeyProvider, resolveApiKey } from '../../infrastructure/secrets/index.js'
import { HttpError, type Route, type RouteResult } from '../../interfaces/http/router.js'
import {
  type AppConfig,
  DEFAULT_LANGUAGE,
  isObject,
  loadEffectiveConfig,
  type ProviderKind,
  readConfigObject,
} from '../config/config.js'
import {
  serialized,
  type UpdateAccountConfigResult,
  updateAccountConfig,
  updateInstallationLanguage,
} from '../config/config-writer.js'
import { consentRequiredBody, consentStateOfKey, recordConsentOfKey } from '../config/consent.js'
import { TEST_TIMEOUT_MS, testProvider } from '../config/provider-test.js'
import { openAiKeyProvider } from '../config/providers.js'
import { type CommandContext, hasSession } from '../context.js'
import { accountLayoutOf, unsafeAccountPath } from '../installation/paths.js'
import { readKey } from './keys.js'
import { type ModelCatalog, unknownModelIn } from './models.js'
import { type AccountRoutesSource, knownAccount } from './routes.js'
import { issueViews, WEB_PROVIDERS } from './settings.js'

export interface SetupRoutesSource extends AccountRoutesSource {
  readonly ctx: Pick<CommandContext, 'layout' | 'env' | 'web' | 'clock'>
  /** Creates an account as `POST /api/accounts` does (same checks). */
  readonly create: (id: string) => Promise<void>
  /** The models the user may choose: a model outside the last list known is refused. */
  readonly models?: ModelCatalog
  /** Told when something an account card shows changed (its settings), so the page hears of it. */
  readonly onChanged: () => void
}

/** `GET /api/setup` and what each change of it answers. Codes and ids only: nothing the user typed except their id. */
export interface SetupView {
  /** True when the wizard is over, skipped, or was never needed (the installation already had a linked account). */
  readonly completed: boolean
  readonly step: SetupStep
  /** The account the wizard is setting up, once the "you" step made it. */
  readonly account: string | null
  /** The account has a registered session (the "link" step can continue). */
  readonly linked: boolean
  /** The language of the installation (the first step takes the browser's, with its time zone, only on a fresh install). */
  readonly language: Language
  /**
   * A truly fresh install: no setup progress, no account and the language still the one `msum init` writes. Only then the
   * page speaks the browser's language from the first screen, and the first step saves it as the installation's.
   */
  readonly freshInstall: boolean
  /** The external providers the account agreed to (RNF-02). */
  readonly consents: readonly string[]
  /** The address Ollama has when its field is emptied (the installation's, without the account's own): who would get the text. */
  readonly ollamaBaseUrl: string
  /** The address `openai` has for this account now (its config or the installation's, or OpenAI's own): who would get the text. */
  readonly openaiBaseUrl: string
}

const OWNER_NAME_MAX = 80
/** What an Ollama address is when nothing sets one. */
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

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
  // Only what the wizard can set today (see `WEB_PROVIDERS`): the others need a model, a key or a command that the wizard
  // has no field for, and are chosen with `msum provider use`.
  if (typeof provider !== 'string' || !(WEB_PROVIDERS as readonly string[]).includes(provider)) {
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
  const baseUrl = text('baseUrl')
  // Only Ollama and OpenAI (for LM Studio, OpenRouter...) have an address of their own: the other providers have a fixed
  // host, and one given for them is a mistake of the caller, not something to ignore.
  if (baseUrl !== undefined && provider !== 'ollama' && provider !== 'openai')
    throw new HttpError(400, 'invalidRequest')
  switch (provider) {
    case 'claude-cli':
      if (model !== undefined) patch['provider.claudeCli.model'] = model
      break
    case 'ollama':
      if (baseUrl !== undefined) patch['provider.ollama.baseUrl'] = baseUrl
      if (model !== undefined) patch['provider.ollama.model'] = model
      break
    default:
      if (baseUrl !== undefined) patch['provider.openai.baseUrl'] = baseUrl
      if (model !== undefined) patch[`provider.${provider}.model`] = model
  }
  return { provider: provider as ProviderKind, patch }
}

/** The consent key of a provider as `config` would have it (`openai` depends on its address, Ollama on where it is). */
const consentKeyOf = (provider: string, config: AppConfig): string | null =>
  consentKeyFor(provider, config.provider.ollama.baseUrl, isOpenAiHost(config.provider.openai.baseUrl))

/** The consents whose recipient is fixed by the program: `true` is enough for them (the page of before sent only that). */
const FIXED_RECIPIENT_KEYS: readonly string[] = ['claude-cli', 'openai', 'anthropic', 'gemini']

/**
 * Whether the body agrees to what `key` discloses. The agreement names its recipient: `consent` is the KEY of the consent
 * (what `consentKeyFor` gives, which the server answers in a 409 `consentRequired`), so an agreement to one recipient is
 * never taken for another (the address of a compatible server or of Ollama may come from the configuration, not from the
 * body). `true` still counts for the keys with a fixed recipient (Claude Code, OpenAI itself, Anthropic, Gemini).
 */
const consentGiven = (value: unknown, key: string): boolean =>
  value === key || (value === true && FIXED_RECIPIENT_KEYS.includes(key))

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
      if (!known && (record.account !== null || stepIndex(record.step) > stepIndex('you'))) {
        const step = stepIndex(record.step) > stepIndex('you') ? 'you' : record.step
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

  /**
   * The consent keys the account has given and that still cover what its configuration says (the same rule as `doctor` and
   * `provider ls`: the kind, the current text, the hosts). The wizard only uses it to tick the box that is already agreed.
   */
  const givenConsents = async (account: string): Promise<string[]> => {
    const resolved = await resolveConfig(account, {})
    if (!resolved.ok) return []
    return EXTERNAL_PROVIDERS.filter((key) => consentStateOfKey(setup, account, key, resolved.config) === 'given')
  }

  const openaiBaseUrlOf = async (account: string | null): Promise<string> => {
    if (account !== null) {
      const resolved = await resolveConfig(account, {})
      if (resolved.ok) return resolved.config.provider.openai.baseUrl
    }
    const root = await readConfigObject(ctx.layout.configFile)
    const provider = root.ok && isObject(root.value.provider) ? root.value.provider : {}
    const openai = isObject(provider.openai) ? provider.openai : {}
    return typeof openai.baseUrl === 'string' && openai.baseUrl !== '' ? openai.baseUrl : OPENAI_BASE_URL
  }

  /**
   * The address Ollama has when the field of the page is emptied: the installation's (or the default), without the account's
   * own value. The page uses it for the notice, the agreement (a server that is not on this machine asks for one) and the
   * list of models, so it never assumes the local default.
   */
  const ollamaBaseUrlOf = async (account: string | null): Promise<string> => {
    if (account !== null) {
      const resolved = await resolveConfig(account, { 'provider.ollama.baseUrl': undefined })
      if (resolved.ok) return resolved.config.provider.ollama.baseUrl
    }
    const loaded = await loadEffectiveConfig(ctx.layout.configFile, null)
    return loaded.ok ? loaded.value.provider.ollama.baseUrl : DEFAULT_OLLAMA_BASE_URL
  }

  /** The one rule of a fresh install, for the view and for the first step. */
  const isFresh = async (record: SetupRecord): Promise<boolean> =>
    record.completedAt === null &&
    record.step === 'you' &&
    record.account === null &&
    installation.accounts().length === 0 &&
    (await languageOf()) === DEFAULT_LANGUAGE

  const view = async (record?: SetupRecord): Promise<SetupView> => {
    const stored = record ?? (await current())
    const account = stored.account
    return {
      completed: stored.completedAt !== null,
      step: stored.step,
      account,
      linked: account === null ? false : await linkedOf(account),
      language: await languageOf(),
      freshInstall: await isFresh(stored),
      consents: account === null ? [] : await givenConsents(account),
      openaiBaseUrl: await openaiBaseUrlOf(account),
      ollamaBaseUrl: await ollamaBaseUrlOf(account),
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

  const stepYou = async (body: Record<string, unknown>, record: SetupRecord): Promise<RouteResult> => {
    const ownerName = typeof body.ownerName === 'string' ? body.ownerName.trim() : ''
    if (ownerName === '' || ownerName.length > OWNER_NAME_MAX) throw new HttpError(400, 'invalidRequest')
    // The page sends the browser's language and time zone. They become the installation's only on a truly fresh install (no account yet and
    // the language still the one `msum init` writes); in any other case it is ignored, so a choice already made stays.
    if (
      body.language !== undefined &&
      (typeof body.language !== 'string' || !(LANGUAGES as readonly string[]).includes(body.language))
    )
      throw new HttpError(400, 'invalidRequest')
    if (body.timezone !== undefined && (typeof body.timezone !== 'string' || body.timezone.length > 100))
      throw new HttpError(400, 'invalidRequest')
    const fresh = await isFresh(record)
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
    // The browser's language and time zone become the installation's only on a truly fresh install. A zone that is not a valid
    // IANA name is ignored (never an error: the daemon keeps the system's).
    const language =
      fresh && typeof body.language === 'string' && body.language !== DEFAULT_LANGUAGE
        ? (body.language as Language)
        : undefined
    const timezone =
      fresh && typeof body.timezone === 'string' && isValidTimezone(body.timezone) ? body.timezone : undefined
    if (language !== undefined || timezone !== undefined) {
      const written = await updateInstallationLanguage({
        rootFile: ctx.layout.configFile,
        ...(language === undefined ? {} : { language }),
        ...(timezone === undefined ? {} : { timezone }),
      })
      if (!written.ok) {
        if (written.error.some((issue) => issue.code === 'concurrentEdit')) throw new HttpError(409, 'concurrentEdit')
        return { status: 422, body: { error: 'invalidConfig', issues: issueViews(written.error) } }
      }
    }
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
    // The model is chosen from a list: one that is not in the last list known for the provider is refused.
    // A model the account already holds (a resumed wizard) is not checked again: only a change is.
    const current = await resolveConfig(id, {})
    const unknown = await unknownModelIn(source, id, patch, current.ok ? current.config : null)
    if (unknown !== null) return { status: 422, body: { error: 'unknownModel', option: unknown } }
    const key = consentKeyOf(provider, resolved.config)
    // The consent is for what the configuration would be after this step (the kind and the hosts it discloses).
    const missing = key !== null && consentStateOfKey(setup, id, key, resolved.config) === 'missing'
    if (key !== null && missing && !consentGiven(body.consent, key)) {
      return { status: 409, body: consentRequiredBody(key, resolved.config) }
    }
    if (key !== null && missing) recordConsentOfKey(setup, id, key, resolved.config)
    const failed = await writeAccount(id, patch)
    if (failed !== null) return failed
    await host.reloadConfig(id)
    onChanged()
    return advance('link', id)
  }

  const stepLink = async (record: SetupRecord): Promise<RouteResult> => {
    if (record.account === null || !(await linkedOf(record.account))) throw new HttpError(409, 'notLinked')
    return advance('done', record.account)
  }

  /**
   * The schedules a finished wizard leaves (09:00 and 18:00, every day), unless the account already has some (a wizard
   * reopened after the user added their own, or one that was completed before). They are edited in the schedules page.
   */
  const defaultSchedules = (account: string): void => {
    if (installation.schedules.list(account).length > 0) return
    for (const time of DEFAULT_SCHEDULE_TIMES) {
      const made = makeSchedule(ALL_WEEKDAYS, time)
      if (made.ok) installation.schedules.add(account, made.value)
    }
    onChanged()
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
            case 'you':
              return stepYou(data, record)
            case 'provider':
              return stepProvider(data, record)
            case 'link':
              return stepLink(record)
            default:
              // The closing screen only follows a linked account: a record that says `done` without one is not finished.
              if (record.account === null || !(await linkedOf(record.account))) throw new HttpError(409, 'notLinked')
              defaultSchedules(record.account)
              setup.complete()
              return { body: await view() }
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
          const key = consentKeyOf(provider, config)
          if (
            key !== null &&
            !consentGiven(data.consent, key) &&
            consentStateOfKey(setup, id, key, config) === 'missing'
          ) {
            return { status: 409, body: consentRequiredBody(key, config) }
          }
          // A key typed in the page is tried without saving it: it lives in the environment of this one call (it wins over
          // the stored ones, like an environment variable does) and nowhere else.
          const env = { ...ctx.env }
          const slot: KeyProvider | null =
            provider === 'openai'
              ? openAiKeyProvider(config.provider.openai.baseUrl)
              : provider === 'anthropic' || provider === 'gemini'
                ? provider
                : null
          const typedKey = data.key === undefined ? undefined : readKey(data.key)
          if (typedKey !== undefined) {
            // A provider that takes no key (Claude Code, Ollama) is not given one.
            if (slot === null) throw new HttpError(400, 'invalidRequest')
            // The key goes to the address the configuration has, which may not be the one the page shows (it is inherited
            // when the body brings none): the page says which key it means (`keyProvider`: `openai` for OpenAI itself,
            // `openai-compatible` for another server) and it must be the one the effective address uses.
            if (provider === 'openai' && data.keyProvider !== slot) throw new HttpError(400, 'invalidRequest')
            env[envNames(slot)[0] as string] = typedKey
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
                openai: { ...config.provider.openai, timeoutMs: Math.min(config.provider.openai.timeoutMs, limit) },
                anthropic: {
                  ...config.provider.anthropic,
                  timeoutMs: Math.min(config.provider.anthropic.timeoutMs, limit),
                },
                gemini: { ...config.provider.gemini, timeoutMs: Math.min(config.provider.gemini.timeoutMs, limit) },
              },
            },
            env,
            Date.now,
            accountLayoutOf(ctx.layout, id),
          )
          // A server that answers 401 when no key was sent did not reject a key: there was none.
          const hadKey =
            typedKey !== undefined ||
            slot === null ||
            resolveApiKey(slot, {
              env: ctx.env,
              accountFile: accountLayoutOf(ctx.layout, id).secretsFile,
              file: ctx.layout.secretsFile,
            }) !== null
          return { body: !tested.ok && tested.error === 'rejected' && !hadKey ? { ok: false, error: 'noKey' } : tested }
        } finally {
          testing = false
        }
      },
    },
    {
      method: 'POST',
      path: '/api/accounts/:id/consents',
      handler: async ({ params, body }) => {
        const id = knownAccount(source, params)
        const { provider, baseUrl } = object(body)
        if (typeof provider !== 'string' || !providerNeedsConsent(provider)) throw new HttpError(400, 'invalidRequest')
        if (baseUrl !== undefined && typeof baseUrl !== 'string') throw new HttpError(400, 'invalidRequest')
        // What is recorded is what the configuration discloses: for an Ollama that is not on this machine, the origin of
        // its address. The page sends the address it is about to save (the settings ask for the consent first).
        const address = typeof baseUrl === 'string' ? baseUrl.trim() : ''
        // A server of the user's choice is agreed to by its address, which the page took from the 409 that asked: without
        // it the agreement would be for whatever the configuration has now, which may not be what was shown.
        if (address === '' && (provider === OLLAMA_REMOTE || provider === 'openai-compatible')) {
          throw new HttpError(400, 'invalidRequest')
        }
        const resolved = await resolveConfig(
          id,
          address === ''
            ? {}
            : provider === OLLAMA_REMOTE
              ? { 'provider.ollama.baseUrl': address }
              : provider === 'openai' || provider === 'openai-compatible'
                ? { 'provider.openai.baseUrl': address }
                : {},
        )
        if (!resolved.ok) return resolved.result
        if (!recordConsentOfKey(setup, id, provider, resolved.config)) throw new HttpError(400, 'invalidRequest')
        return { status: 201, body: { provider, textVersion: CONSENT_TEXT_VERSION } }
      },
    },
  ]
}

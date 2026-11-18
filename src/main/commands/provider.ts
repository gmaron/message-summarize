import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SummarizeRequest } from '../../application/ports/summarizer.js'
import { parseSummaryResponse } from '../../domain/summary.js'
import type { Catalog } from '../../infrastructure/i18n/index.js'
import {
  isOnMachine,
  isOpenAiHost,
  OPENAI_BASE_URL,
  PROVIDER_INFO,
  PROVIDER_INFO_KINDS,
  type ProviderInfoKind,
  resolveExecutable,
} from '../../infrastructure/llm/index.js'
import { excerpt } from '../../infrastructure/llm/summary-schema.js'
import { createRenderers } from '../../infrastructure/rendering/index.js'
import { type KeyProvider, resolveApiKey } from '../../infrastructure/secrets/index.js'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type ProviderCommand } from '../../interfaces/cli/run.js'
import { isPrepared, type PreparedAccount, prepareAccount } from '../account-command.js'
import { type AppConfig, describeConfigIssue, mergeConfigJson, type ProviderKind, parseConfig } from '../config.js'
import {
  consentHosts,
  findConsent,
  kindOfProvider,
  leavesMachine,
  needsConsent,
  originOf,
  recordConsent,
} from '../consent.js'
import type { CommandContext } from '../context.js'
import { buildProvider } from '../providers.js'

type Obj = Record<string, unknown>
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The provider of the configuration that a kind of the table stands for. */
const realKind = (kind: ProviderInfoKind): ProviderKind => (kind === 'openai-compatible' ? 'openai' : kind)

/** The section of `provider` that holds the model of a kind, or null when it has no model. */
const SECTION: Readonly<Record<ProviderKind, string | null>> = {
  'claude-cli': 'claudeCli',
  'gemini-cli': null,
  'codex-cli': null,
  'generic-cli': null,
  ollama: 'ollama',
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
}

/** The model the configuration holds for a kind. Null when it has none (or the kind has no model). */
function modelOf(config: AppConfig, kind: ProviderInfoKind): string | null {
  switch (realKind(kind)) {
    case 'claude-cli':
      return config.provider.claudeCli.model
    case 'ollama':
      return config.provider.ollama.model
    case 'openai':
      return config.provider.openai.model
    case 'anthropic':
      return config.provider.anthropic.model
    case 'gemini':
      return config.provider.gemini.model
    default:
      return null
  }
}

/** The kinds that need a model to be chosen (there is no default model for them). Claude has a default. */
const NEEDS_MODEL = new Set<ProviderInfoKind>(['ollama', 'openai', 'openai-compatible', 'anthropic', 'gemini'])

/** The stored key a kind uses, or null when it uses none. */
function keyNameOf(kind: ProviderInfoKind): KeyProvider | null {
  switch (kind) {
    case 'openai':
    case 'openai-compatible':
    case 'anthropic':
    case 'gemini':
      return kind
    default:
      return null
  }
}

// What each provider needs to have been disclosed (kinds, hosts, consent) is in `../consent.js`, shared with the web.
export { consentHosts, kindOfProvider, leavesMachine, needsConsent, originOf }

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The hosts of a kind as text (RNF-01), in the language of the catalog. */
export function hostsText(texts: Catalog['cli']['provider'], config: AppConfig, kind: ProviderInfoKind): string {
  switch (kind) {
    case 'gemini-cli':
    case 'codex-cli':
      return texts.hostsDisabled
    case 'generic-cli':
      return texts.hostsYourCommand
    case 'ollama':
      return isOnMachine(config.provider.ollama.baseUrl) ? texts.hostsNone : originOf(config.provider.ollama.baseUrl)
    case 'openai-compatible':
      return isOpenAiHost(config.provider.openai.baseUrl)
        ? texts.hostsYourServer
        : `${texts.hostsYourServer} (${hostOf(config.provider.openai.baseUrl)})`
    default:
      return PROVIDER_INFO[kind].hosts.join(', ')
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// provider ls

type SecretTexts = Catalog['cli']['secret']

async function describeUsable(
  ctx: CommandContext,
  prepared: PreparedAccount,
  kind: ProviderInfoKind,
): Promise<{ readonly key: string; readonly usable: string }> {
  const { config, catalog, account } = prepared
  const texts = catalog.cli.provider.ls
  const doctor = catalog.cli.doctor
  const secret: SecretTexts = catalog.cli.secret
  const keyName = keyNameOf(kind)
  const noKey = catalog.cli.provider.ls.keyNotNeeded
  switch (kind) {
    case 'gemini-cli':
    case 'codex-cli':
      return { key: noKey, usable: texts.usableDisabled }
    case 'generic-cli': {
      const { command, acknowledgeRisk } = config.provider.genericCli
      if (command === null) return { key: noKey, usable: texts.usableNoCommand }
      if (!acknowledgeRisk) return { key: noKey, usable: texts.usableNotAcknowledged }
      if (resolveExecutable(command[0] ?? '', ctx.env) === null) {
        return { key: noKey, usable: texts.usableVerifyFailed(doctor.providerMissing(command[0] ?? '')) }
      }
      return { key: noKey, usable: texts.usableYes }
    }
    case 'ollama':
      return {
        key: noKey,
        usable: config.provider.ollama.model === null ? texts.usableNoModel : texts.usableNotChecked,
      }
    case 'claude-cli': {
      const verified = await ctx.probes.verifyCli(config.provider.claudeCli.command, ctx.env)
      if (verified.ok) return { key: noKey, usable: texts.usableYes }
      const detail =
        verified.kind === 'notFound'
          ? doctor.providerMissing(config.provider.claudeCli.command)
          : verified.kind === 'missingFlags'
            ? doctor.cliMissingFlags(kind, verified.flags.join(', '))
            : doctor.cliUnrunnable(kind)
      return { key: noKey, usable: texts.usableVerifyFailed(detail) }
    }
    default: {
      // an API: the model and the key, with no request
      const name = keyName as KeyProvider
      const found = resolveApiKey(name, {
        env: ctx.env,
        accountFile: account.secretsFile,
        file: ctx.layout.secretsFile,
      })
      const sourceText =
        found === null
          ? ''
          : found.source.kind === 'env'
            ? secret.sourceEnv(found.source.name)
            : found.source.kind === 'accountFile'
              ? secret.sourceAccountFile(found.source.file)
              : secret.sourceFile(found.source.file)
      const key =
        found !== null
          ? texts.keyFrom(name, sourceText)
          : name === 'openai-compatible'
            ? texts.keyOptional(name)
            : texts.keyMissing(name)
      if (modelOf(config, kind) === null) return { key, usable: texts.usableNoModel }
      if (found === null && name !== 'openai-compatible') return { key, usable: texts.usableNoKey(name) }
      return { key, usable: texts.usableYes }
    }
  }
}

async function listProviders(ctx: CommandContext, prepared: PreparedAccount): Promise<number> {
  const { config, catalog, account } = prepared
  const texts = catalog.cli.provider
  const { io } = ctx
  io.out(texts.ls.title(account.id))
  for (const kind of PROVIDER_INFO_KINDS) {
    const info = PROVIDER_INFO[kind]
    const configured =
      kindOfProvider(config, config.provider.primary) === kind
        ? texts.roles.primary
        : kindOfProvider(config, config.provider.backup) === kind
          ? texts.roles.backup
          : texts.roles.none
    const { key, usable } = await describeUsable(ctx, prepared, kind)
    io.out(texts.ls.kind(kind, texts.descriptions[kind]))
    io.out(
      texts.ls.info(
        texts.charge[info.charge],
        leavesMachine(kind, config) ? texts.dataLeaves : texts.dataStays,
        hostsText(texts, config, kind),
        info.policyUrl ?? texts.policyNone,
      ),
    )
    // An Ollama that is not on this machine is a server of the user's, but the chats do go out to it.
    if (kind === 'ollama' && leavesMachine(kind, config)) {
      io.out(texts.ls.ollamaRemote(originOf(config.provider.ollama.baseUrl)))
    }
    io.out(texts.ls.state(configured, key, usable))
    // RNF-02: for a provider that is configured and sends the chats out, whether the user accepted it
    if (configured !== texts.roles.none && needsConsent(kind, config)) {
      const accepted = findConsent(prepared.installation.setup, account.id, kind, config)
      io.out(accepted === null ? texts.ls.consentNone : texts.ls.consent(accepted.givenAt.slice(0, 10)))
    }
  }
  io.out(texts.ls.footer)
  return EXIT_OK
}

// ---------------------------------------------------------------------------------------------------------------------
// provider use

type ReadFile = { readonly ok: true; readonly object: Obj } | { readonly ok: false }

/** The JSON object in a config file; a file that does not exist is an empty object; anything else is refused. */
async function readObject(file: string): Promise<ReadFile> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, object: {} }
    throw error
  }
  try {
    const json: unknown = JSON.parse(raw)
    return isObject(json) ? { ok: true, object: json } : { ok: false }
  } catch {
    return { ok: false }
  }
}

/** What identifies a version of a file: when it was modified and how big it is. Null when it does not exist. */
type FileStamp = { readonly mtimeMs: number; readonly size: number } | null

async function stampOf(file: string): Promise<FileStamp> {
  try {
    const info = await stat(file)
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const sameStamp = (a: FileStamp, b: FileStamp): boolean =>
  a === null || b === null ? a === b : a.mtimeMs === b.mtimeMs && a.size === b.size

/**
 * Writes the whole file atomically (a temporary file in the same directory, then a rename), 2-space JSON, mode 0600.
 * Just before the rename the file is looked at again: if it changed since `expected` (someone edited it while the user was
 * being asked), nothing is written and it returns false.
 */
async function writeConfig(file: string, object: Obj, expected: FileStamp): Promise<boolean> {
  const temporary = join(dirname(file), `.config-${process.pid}-${Date.now()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(object, null, 2)}\n`, { mode: 0o600 })
    if (!sameStamp(await stampOf(file), expected)) {
      await rm(temporary, { force: true })
      return false
    }
    await rename(temporary, file)
    return true
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function useProvider(
  ctx: CommandContext,
  prepared: PreparedAccount,
  command: Extract<ProviderCommand, { action: 'use' }>,
): Promise<number> {
  const { config, catalog, account, installation } = prepared
  const texts = catalog.cli.provider
  const u = texts.use
  const { io } = ctx
  const kind = command.kind
  const info = PROVIDER_INFO[kind]

  if (kind === 'gemini-cli' || kind === 'codex-cli') {
    io.err(catalog.cli.doctor.cliDisabled(kind))
    io.err(catalog.cli.doctor.cliDisabledFix(kind))
    return EXIT_FAILURE
  }
  if (kind === 'openai-compatible') {
    if (command.baseUrl === null) {
      io.err(u.baseUrlRequired)
      return EXIT_USAGE
    }
    if (isOpenAiHost(command.baseUrl)) {
      io.err(u.baseUrlIsOpenAi)
      return EXIT_USAGE
    }
  } else if (command.baseUrl !== null) {
    io.err(u.baseUrlOnlyCompatible)
    return EXIT_USAGE
  }
  if (kind === 'generic-cli' && command.model !== null) {
    io.err(u.modelNotForGeneric)
    return EXIT_USAGE
  }

  // Always the config.json of THIS account, created if it does not exist, never the installation's: the consent is per
  // account, so the provider it covers must be per account too. (Otherwise an account linked later would inherit an
  // external provider that it never saw disclosed.)
  const target = account.configFile
  const stamp = await stampOf(target)
  const targetRead = await readObject(target)
  const rootRead = await readObject(ctx.layout.configFile)
  for (const [file, read] of [
    [target, targetRead],
    [ctx.layout.configFile, rootRead],
  ] as const) {
    if (!read.ok) {
      io.err(u.fileNotJson(file))
      io.err(u.notWritten(file))
      return EXIT_FAILURE
    }
  }

  // The edit: everything else in the file stays as it is.
  const edited = structuredClone((targetRead as { object: Obj }).object)
  const provider: Obj = isObject(edited.provider) ? edited.provider : {}
  edited.provider = provider
  const actual = realKind(kind)
  const role = command.backup ? 'backup' : 'primary'
  provider[role] = actual
  const section = SECTION[actual]
  if (section !== null) {
    const sectionObject: Obj = isObject(provider[section]) ? (provider[section] as Obj) : {}
    provider[section] = sectionObject
    if (command.model !== null) sectionObject.model = command.model
    if (kind === 'openai-compatible' && command.baseUrl !== null) sectionObject.baseUrl = command.baseUrl
    // Back to OpenAI itself: a base URL of another server that the configuration still has must not stay.
    if (kind === 'openai' && !isOpenAiHost(config.provider.openai.baseUrl)) sectionObject.baseUrl = OPENAI_BASE_URL
  }

  // Validated as the whole configuration the account would run with: an invalid result writes nothing.
  const parsed = parseConfig(mergeConfigJson((rootRead as { object: Obj }).object, edited), config.timezone)
  if (!parsed.ok) {
    io.err(catalog.cli.config.heading)
    for (const issue of parsed.error) io.err(`  - ${describeConfigIssue(catalog, issue)}`)
    if (parsed.error.some((issue) => issue.code === 'required' && issue.option.endsWith('.model')))
      io.err(u.noModelHint)
    io.err(u.notWritten(target))
    return EXIT_USAGE
  }

  // RNF-02: what leaves the machine, and where to, before a provider that sends it is activated.
  if (kind === 'generic-cli') io.out(u.genericExplain)
  if (leavesMachine(kind, parsed.value)) {
    const merged = parsed.value
    io.out(u.disclosureTitle(kind))
    io.out(u.disclosureSends)
    // The generic CLI: the command itself is what was disclosed (changing it needs a new consent).
    if (kind === 'generic-cli') io.out(u.disclosureCommand(JSON.stringify(merged.provider.genericCli.command ?? [])))
    else io.out(u.disclosureHosts(hostsText(texts, merged, kind)))
    io.out(info.policyUrl === null ? u.disclosureNoPolicy : u.disclosurePolicy(info.policyUrl))
    io.out(u.disclosureLocalOnly)
    if (!command.yes && !(await ctx.confirm(u.confirm(kind)))) {
      io.err(u.cancelled)
      io.err(u.noTerminal)
      return EXIT_FAILURE
    }
  }

  if (!(await writeConfig(target, edited, stamp))) {
    io.err(u.changedWhileEditing(target))
    return EXIT_FAILURE
  }
  // The user was shown what is sent and accepted (asked, or `--yes`): recorded for THIS account (RNF-02).
  recordConsent(installation.setup, account.id, kind, parsed.value)
  io.out(u.wrote(target, texts.roles[role], kind))
  const keyName = keyNameOf(kind)
  if (
    keyName !== null &&
    keyName !== 'openai-compatible' &&
    resolveApiKey(keyName, { env: ctx.env, accountFile: account.secretsFile, file: ctx.layout.secretsFile }) === null
  ) {
    io.out(u.keyReminder(keyName))
  }
  if (kind === 'generic-cli' && !parsed.value.provider.genericCli.acknowledgeRisk) io.out(u.genericNotAcknowledged)
  io.out(u.testReminder)
  return EXIT_OK
}

// ---------------------------------------------------------------------------------------------------------------------
// provider test

/** The made-up conversation of the test. Invented names and text: the messages of the account are never used. */
export const TEST_OWNER = 'Alex Prueba'
export const TEST_CONTACT = 'Marta Ejemplo'
export const TEST_TRANSCRIPT = [
  `Chat con: ${TEST_CONTACT}`,
  '',
  `${TEST_CONTACT}: Hola Alex, ¿podés confirmarme si el sábado venís a la reunión del club de ajedrez?`,
  `${TEST_CONTACT}: Necesito saber antes del jueves para reservar la mesa.`,
  `${TEST_OWNER} [VOS]: Dale, lo veo y te aviso.`,
].join('\n')

export type FailureHint =
  | 'missingKey'
  | 'authFailed'
  | 'unknownModel'
  | 'rateLimit'
  | 'noCredit'
  | 'timeout'
  | 'disabled'
  | 'verifyFailed'
  | 'unreachable'
  | 'redirect'
  | 'geminiSchemaShape'
  | 'generic'

/**
 * What a failed test most likely means, from the reason the adapter gave (already redacted, never with a key). The order
 * matters: a Gemini answer that complains about the key is an authentication problem even though it is a 400.
 */
export function classifyFailure(kind: ProviderInfoKind, reason: string): FailureHint {
  if (/^no API key for/.test(reason)) return 'missingKey'
  if (/ is disabled/.test(reason)) return 'disabled'
  if (/cannot be run without tools|was not found|--help did not run/.test(reason)) return 'verifyFailed'
  if (/redirect/i.test(reason)) return 'redirect'
  if (/answered (401|403)\b/.test(reason) || /api[_ ]key (is )?(not valid|invalid)|API_KEY_INVALID/i.test(reason)) {
    return 'authFailed'
  }
  if (
    kind === 'gemini' &&
    /answered 400\b/.test(reason) &&
    /(json_?schema|response_?schema|response_?mime|generation_?config|unknown name|invalid json payload|invalid_argument)/i.test(
      reason,
    )
  ) {
    return 'geminiSchemaShape'
  }
  if (/answered 404\b/.test(reason) || /model\b.{0,60}(not found|does not exist|unknown|invalid)/i.test(reason)) {
    return 'unknownModel'
  }
  if (
    /answered 429\b/.test(reason) &&
    /insufficient_quota|no credits|credit balance|billing|spend(ing)? limit/i.test(reason)
  ) {
    return 'noCredit'
  }
  if (/answered (429|503|529)\b|gave up after|over the budget/.test(reason)) return 'rateLimit'
  if (/timed out|total time limit/.test(reason)) return 'timeout'
  if (/could not reach/.test(reason)) return 'unreachable'
  return 'generic'
}

async function testProvider(
  ctx: CommandContext,
  prepared: PreparedAccount,
  command: Extract<ProviderCommand, { action: 'test' }>,
): Promise<number> {
  const { config, catalog, account } = prepared
  const texts = catalog.cli.provider
  const t = texts.test
  const { io } = ctx

  const role = command.backup ? 'backup' : 'primary'
  const kind = command.kind ?? kindOfProvider(config, command.backup ? config.provider.backup : config.provider.primary)
  if (kind === null) {
    io.err(t.noneConfigured(texts.roles[role]))
    return EXIT_FAILURE
  }
  if (NEEDS_MODEL.has(kind) && modelOf(config, kind) === null) {
    io.err(t.noModel(kind))
    return EXIT_FAILURE
  }

  // What goes out, said before it does: only the made-up conversation (nothing of the account is read).
  if (kind !== 'gemini-cli' && kind !== 'codex-cli') {
    io.out(
      kind === 'ollama'
        ? t.noticeLocal(config.provider.ollama.baseUrl)
        : t.noticeExternal(hostsText(texts, config, kind)),
    )
  }
  io.out(t.running(kind))

  const summarizer = buildProvider(realKind(kind), config, ctx.env, account, ctx.providerBaseUrls)
  const request: SummarizeRequest = {
    conversation: { id: 'prueba-1@example.invalid', name: TEST_CONTACT, isGroup: false },
    systemPrompt: createRenderers(config.language, config.timezone).systemPrompt.render(null, TEST_OWNER),
    transcript: TEST_TRANSCRIPT,
  }
  const started = Date.now()
  const result = await summarizer.summarize(request)
  const elapsed = Date.now() - started

  let reason: string
  if (result.ok) {
    const valid = parseSummaryResponse(result.value)
    if (valid.ok) {
      io.out(t.ok(kind, elapsed, valid.value.needsReply ? t.yes : t.no, t.priorities[valid.value.priority]))
      return EXIT_OK
    }
    reason = `invalid summary: ${valid.error.join(', ')}`
  } else {
    reason = result.error
  }
  io.err(t.failed(kind, excerpt(reason, 400)))
  const hint = classifyFailure(kind, reason)
  const name = keyNameOf(kind) ?? 'openai'
  io.err(hint === 'missingKey' ? t.hints.missingKey(name) : t.hints[hint])
  return EXIT_FAILURE
}

/**
 * `msum provider ls|use|test` (RF-41, RNF-02, RF-81). `ls` shows what each provider is, whether it is configured and
 * usable here, with no network call. `use` chooses one in the config.json of the account (or the installation's when
 * there is a single account), after saying what it receives and asking. `test` makes ONE real call with a made-up
 * conversation, never with the messages of the account.
 */
export async function providerCommand(ctx: CommandContext, command: ProviderCommand): Promise<number> {
  const prepared = await prepareAccount(ctx, command.account, 'existing')
  if (!isPrepared(prepared)) return prepared.exit
  try {
    switch (command.action) {
      case 'ls':
        return await listProviders(ctx, prepared)
      case 'use':
        return await useProvider(ctx, prepared, command)
      case 'test':
        return await testProvider(ctx, prepared, command)
    }
  } finally {
    prepared.installation.close()
  }
}

import { existsSync } from 'node:fs'
import { type Catalog, getCatalog } from '../../infrastructure/i18n/index.js'
import { EXIT_FAILURE, EXIT_OK } from '../../interfaces/cli/run.js'
import { describeConfigIssue, languageHint, loadConfig, type ProviderKind } from '../config.js'
import { type CommandContext, hasSession } from '../context.js'
import { loosePermissions } from '../paths.js'
import { createRuntime } from '../runtime.js'

/** Oldest Node this project supports (package.json "engines"). */
export const MINIMUM_NODE = '22.16.0'

/** Compares dotted versions numerically: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * `msum doctor` (RF-81, minimal): Node version, data directory permissions, a valid configuration, the provider
 * command (or Ollama server) and the linked WhatsApp account. Each failure says how to fix it. Exit code 1 if any fails.
 * The only things it contacts are the configured provider and, for Ollama, the configured base URL.
 */
export async function doctorCommand(ctx: CommandContext): Promise<number> {
  const { io, layout } = ctx
  const loaded = await loadConfig(layout.configFile)
  const catalog: Catalog = getCatalog(loaded.ok ? loaded.value.language : await languageHint(layout.configFile))
  const texts = catalog.cli.doctor
  let failed = false
  const ok = (name: string, detail: string): void => io.out(texts.ok(name, detail))
  const fail = (name: string, detail: string, fix: string): void => {
    failed = true
    io.out(texts.fail(name, detail, fix))
  }
  io.out(texts.title)

  // Node
  if (compareVersions(ctx.nodeVersion, MINIMUM_NODE) >= 0) ok(texts.names.node, texts.node(ctx.nodeVersion))
  else fail(texts.names.node, texts.node(ctx.nodeVersion), texts.nodeFix(MINIMUM_NODE))

  // Data directory
  const loose = await loosePermissions(layout)
  const firstLoose = loose[0]
  if (firstLoose === undefined) ok(texts.names.dataDir, texts.dataDirOk)
  else fail(texts.names.dataDir, texts.dataDirBad(firstLoose.path, firstLoose.mode), texts.dataDirFix(firstLoose.path))

  // Configuration
  if (!loaded.ok) {
    fail(
      texts.names.config,
      loaded.error.map((issue) => describeConfigIssue(catalog, issue)).join(' '),
      texts.configFix,
    )
  } else {
    ok(texts.names.config, texts.configOk)
    const { provider } = loaded.value
    const kinds: ProviderKind[] = [provider.primary, provider.backup].filter((k): k is ProviderKind => k !== null)
    if (kinds.length === 0) fail(texts.names.provider, texts.providerNone, catalog.cli.config.noProvider)
    for (const kind of kinds) {
      if (kind === 'claude-cli') {
        const version = await ctx.probes.commandVersion(provider.claudeCli.command, ctx.env)
        if (version === null)
          fail(texts.names.provider, texts.providerMissing(provider.claudeCli.command), texts.providerFix(kind))
        else ok(texts.names.provider, texts.providerOk(kind, version))
      } else {
        const reachable = await ctx.probes.ollamaReachable(provider.ollama.baseUrl)
        if (!reachable)
          fail(texts.names.provider, texts.providerMissing(provider.ollama.baseUrl), texts.providerFix(kind))
        else ok(texts.names.provider, texts.providerOk(kind, provider.ollama.baseUrl))
      }
    }
  }

  // WhatsApp account
  let linked = false
  if (loaded.ok && existsSync(layout.dbFile)) {
    const runtime = createRuntime({ layout, config: loaded.value, env: ctx.env, clock: ctx.clock, summarizer: null })
    try {
      linked = runtime.identity.get() !== null && (await hasSession(layout))
    } finally {
      runtime.close()
    }
  }
  if (linked) ok(texts.names.whatsapp, texts.whatsappOk)
  else fail(texts.names.whatsapp, texts.whatsappNone, texts.whatsappFix)

  io.out(failed ? texts.summaryFail : texts.summaryOk)
  return failed ? EXIT_FAILURE : EXIT_OK
}

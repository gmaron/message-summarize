import { existsSync } from 'node:fs'
import { type Catalog, getCatalog } from '../../infrastructure/i18n/index.js'
import type { AccountArg } from '../../interfaces/cli/args.js'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../../interfaces/cli/run.js'
import { openInstallation } from '../accounts.js'
import { describeConfigIssue, languageHint, loadEffectiveConfig, type ProviderKind } from '../config.js'
import { type CommandContext, hasSession } from '../context.js'
import { type AccountLayout, accountLayoutOf, loosePermissions } from '../paths.js'
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
 * `msum doctor` (RF-81, minimal): Node version, data directory permissions and, for every account (or the one of
 * `--account`): a valid configuration (the installation's with the account's overrides), the provider command (or
 * Ollama server) and the linked WhatsApp account. It also reports what `app.db` and `accounts/` disagree on. Each
 * failure says how to fix it. Exit code 1 if any fails.
 * The only things it contacts are the configured providers and, for Ollama, the configured base URL.
 */
export async function doctorCommand(ctx: CommandContext, args: AccountArg): Promise<number> {
  const { io, layout } = ctx
  // Looked at BEFORE opening the installation, which tightens the data and accounts directories.
  const looseBefore = await loosePermissions(layout)
  const opened = await openInstallation({ layout, clock: ctx.clock })
  if (!opened.ok) {
    io.err(getCatalog(await languageHint(layout.configFile)).cli.legacyDaemonRunning(opened.pid))
    return EXIT_FAILURE
  }
  const { installation } = opened
  try {
    const known = installation.accounts().map((row) => row.id)
    if (args.account !== null && !known.includes(args.account)) {
      io.err(getCatalog(await languageHint(layout.configFile)).cli.accounts.unknown(args.account, known.join(', ')))
      return EXIT_USAGE
    }
    // No account yet: the installation configuration is still checked, and "no account linked" is reported.
    const targets: (AccountLayout | null)[] =
      args.account !== null ? [accountLayoutOf(layout, args.account)] : known.map((id) => accountLayoutOf(layout, id))
    if (targets.length === 0) targets.push(null)

    const firstConfig = await loadEffectiveConfig(layout.configFile, targets[0]?.configFile ?? null)
    const catalog: Catalog = getCatalog(
      firstConfig.ok
        ? firstConfig.value.language
        : await languageHint(layout.configFile, targets[0]?.configFile ?? null),
    )
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
    const looseAfter = await loosePermissions(
      layout,
      known.map((id) => accountLayoutOf(layout, id)),
    )
    const loose = [...looseBefore, ...looseAfter.filter((p) => !looseBefore.some((b) => b.path === p.path))]
    const firstLoose = loose[0]
    if (firstLoose === undefined) ok(texts.names.dataDir, texts.dataDirOk)
    else
      fail(texts.names.dataDir, texts.dataDirBad(firstLoose.path, firstLoose.mode), texts.dataDirFix(firstLoose.path))

    // What app.db and accounts/ say about each other
    const { report } = installation
    const registryProblems = [
      ...report.missingDirs.map((id) => [texts.accountsMissingDir(id), texts.accountsMissingDirFix(id)] as const),
      ...(report.invalidRows.length > 0
        ? [[texts.accountsInvalid(report.invalidRows.join(', ')), texts.accountsInvalidFix] as const]
        : []),
      ...(report.ignoredEntries.length > 0
        ? [[texts.accountsIgnored(report.ignoredEntries.join(', ')), texts.accountsIgnoredFix] as const]
        : []),
      ...(report.legacyConflict ? [[texts.legacyConflict, texts.legacyConflictFix] as const] : []),
    ]
    if (registryProblems.length === 0) ok(texts.names.accounts, texts.accountsOk(known.length))
    for (const [detail, fix] of registryProblems) fail(texts.names.accounts, detail, fix)

    for (const account of targets) {
      // With several accounts each line says which one it is about.
      const label = (name: string): string =>
        targets.length > 1 && account !== null ? texts.accountName(name, account.id) : name
      const loaded = account === null ? firstConfig : await loadEffectiveConfig(layout.configFile, account.configFile)
      const accountCatalog: Catalog = loaded.ok ? getCatalog(loaded.value.language) : catalog
      const accountTexts = accountCatalog.cli.doctor

      // Configuration
      if (!loaded.ok) {
        fail(
          label(accountTexts.names.config),
          loaded.error.map((issue) => describeConfigIssue(accountCatalog, issue)).join(' '),
          accountTexts.configFix,
        )
      } else {
        ok(label(accountTexts.names.config), accountTexts.configOk)
        const { provider } = loaded.value
        const kinds: ProviderKind[] = [provider.primary, provider.backup].filter((k): k is ProviderKind => k !== null)
        if (kinds.length === 0) {
          fail(label(accountTexts.names.provider), accountTexts.providerNone, accountCatalog.cli.config.noProvider)
        }
        for (const kind of kinds) {
          if (kind === 'claude-cli') {
            const version = await ctx.probes.commandVersion(provider.claudeCli.command, ctx.env)
            if (version === null) {
              fail(
                label(accountTexts.names.provider),
                accountTexts.providerMissing(provider.claudeCli.command),
                accountTexts.providerFix(kind),
              )
            } else ok(label(accountTexts.names.provider), accountTexts.providerOk(kind, version))
          } else {
            const reachable = await ctx.probes.ollamaReachable(provider.ollama.baseUrl)
            if (!reachable) {
              fail(
                label(accountTexts.names.provider),
                accountTexts.providerMissing(provider.ollama.baseUrl),
                accountTexts.providerFix(kind),
              )
            } else ok(label(accountTexts.names.provider), accountTexts.providerOk(kind, provider.ollama.baseUrl))
          }
        }
      }

      // WhatsApp account
      let linked = false
      if (account !== null && loaded.ok && existsSync(account.dbFile)) {
        const runtime = createRuntime({
          layout: account,
          config: loaded.value,
          env: ctx.env,
          clock: ctx.clock,
          summarizer: null,
        })
        try {
          linked = runtime.identity.get() !== null && (await hasSession(account))
        } finally {
          runtime.close()
        }
      }
      if (linked) ok(label(accountTexts.names.whatsapp), accountTexts.whatsappOk)
      else fail(label(accountTexts.names.whatsapp), accountTexts.whatsappNone, accountTexts.whatsappFix)
    }

    io.out(failed ? texts.summaryFail : texts.summaryOk)
    return failed ? EXIT_FAILURE : EXIT_OK
  } finally {
    installation.close()
  }
}

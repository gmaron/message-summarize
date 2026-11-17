import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { type Catalog, getCatalog } from '../../infrastructure/i18n/index.js'
import { findModelByFile, resolveModelPath, sha256File } from '../../infrastructure/transcription/index.js'
import { mediaDirectoryBytes } from '../../infrastructure/whatsapp/media.js'
import type { AccountArg } from '../../interfaces/cli/args.js'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../../interfaces/cli/run.js'
import { openInstallation } from '../accounts.js'
import { describeConfigIssue, languageHint, loadEffectiveConfig, type ProviderKind } from '../config.js'
import { type CommandContext, hasSession } from '../context.js'
import { IMPORT_DIR_PATTERN, importDirs } from '../import-workdirs.js'
import { type AccountLayout, accountLayoutOf, loosePermissions } from '../paths.js'
import { createRuntime } from '../runtime.js'
import { importConfigSchedules, unrepresentableCrons } from '../schedules.js'

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
    // Work directories of imports: one that is running is not a problem; one that died holds a copy of a session.
    const staleImports = (await importDirs(layout)).filter((dir) => !dir.live).map((dir) => dir.name)
    const ignoredEntries = report.ignoredEntries.filter((name) => !IMPORT_DIR_PATTERN.test(name))
    const registryProblems = [
      ...(staleImports.length > 0 ? [[texts.staleImport(staleImports.join(', ')), texts.staleImportFix] as const] : []),
      ...report.missingDirs.map((id) => [texts.accountsMissingDir(id), texts.accountsMissingDirFix(id)] as const),
      ...(report.invalidRows.length > 0
        ? [[texts.accountsInvalid(report.invalidRows.join(', ')), texts.accountsInvalidFix] as const]
        : []),
      ...(ignoredEntries.length > 0
        ? [[texts.accountsIgnored(ignoredEntries.join(', ')), texts.accountsIgnoredFix] as const]
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

        // Transcription (RF-81, RF-21): off is fine. On, the program, ffmpeg and the model must be there, or audios stay
        // untranscribed (the product works either way, but the user asked for transcripts).
        const transcription = loaded.value.transcription
        if (!transcription.enabled) ok(label(accountTexts.names.transcription), accountTexts.transcriptionOff)
        else {
          ok(label(accountTexts.names.transcription), accountTexts.transcriptionOn(transcription.language))
          // whisper.cpp has no stable `--version`: the program counts as found when it can be started at all, and the
          // version is shown only when it answered the flag.
          const whisper = await ctx.probes.commandProbe(transcription.whisperCommand, ['--version'], ctx.env)
          if (!whisper.started) {
            fail(
              label(accountTexts.names.whisper),
              accountTexts.whisperMissing(transcription.whisperCommand),
              accountTexts.whisperFix,
            )
          } else ok(label(accountTexts.names.whisper), accountTexts.whisperOk(whisper.ok ? whisper.line : null))
          const ffmpeg = await ctx.probes.commandProbe(transcription.ffmpegCommand, ['-version'], ctx.env)
          if (!ffmpeg.started) {
            fail(
              label(accountTexts.names.ffmpeg),
              accountTexts.ffmpegMissing(transcription.ffmpegCommand),
              accountTexts.ffmpegFix,
            )
          } else ok(label(accountTexts.names.ffmpeg), accountTexts.ffmpegOk(ffmpeg.ok ? ffmpeg.line : null))
          const modelName = label(accountTexts.names.whisperModel)
          if (transcription.model === null) fail(modelName, accountTexts.modelNone, accountTexts.modelNoneFix)
          else {
            const path = resolveModelPath(layout.modelsDir, layout.dataDir, transcription.model)
            if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) {
              fail(modelName, accountTexts.modelMissing(path), accountTexts.modelMissingFix)
            } else {
              const known = findModelByFile(basename(path), ctx.whisperModels)
              if (known === undefined) {
                io.out(
                  accountTexts.warn(modelName, accountTexts.modelUnverified(path), accountTexts.modelUnverifiedFix),
                )
              } else if ((await sha256File(path).catch(() => null)) === known.sha256) {
                ok(modelName, accountTexts.modelVerified(path))
              } else fail(modelName, accountTexts.modelBadChecksum(path), accountTexts.modelBadChecksumFix)
            }
          }
          // The audios are deleted once transcribed: a folder that is (nearly) full means they pile up. New ones are
          // refused at the cap, so the user is told before that happens.
          if (account !== null) {
            const used = await mediaDirectoryBytes(account.mediaDir)
            const cap = transcription.maxMediaMb * 1024 * 1024
            if (used >= cap * 0.9) {
              io.out(
                accountTexts.warn(
                  label(accountTexts.names.mediaFiles),
                  accountTexts.mediaFull(Math.round(used / 1024 / 1024), transcription.maxMediaMb),
                  accountTexts.mediaFullFix,
                ),
              )
            }
          }
        }
      }

      // Schedules (RF-60): in the database; the "schedules" of the configuration were imported once
      if (account !== null && loaded.ok) {
        importConfigSchedules(installation, account.id, loaded.value)
        const notImported = unrepresentableCrons(loaded.value)
        const count = installation.schedules.list(account.id).length
        const name = label(accountTexts.names.schedules)
        if (notImported.length > 0) {
          // Once imported (the flag is set) what could not be imported is a notice, not a failure: the key is ignored.
          const detail = accountTexts.schedulesNotImported(notImported.join(', '))
          if (installation.schedules.imported(account.id)) {
            io.out(accountTexts.warn(name, detail, accountTexts.schedulesNotImportedFix))
          } else fail(name, detail, accountTexts.schedulesNotImportedFix)
        }
        if (count === 0) io.out(accountTexts.warn(name, accountTexts.schedulesNone, accountTexts.schedulesNoneFix))
        else if (loaded.value.provider.primary === null) {
          fail(name, accountTexts.schedulesNoProvider, accountCatalog.cli.config.noProvider)
        } else ok(name, accountTexts.schedulesOk(count))
        if (loaded.value.schedules.length > 0) {
          io.out(
            accountTexts.warn(
              label(accountTexts.names.schedules),
              accountTexts.schedulesIgnored,
              accountTexts.schedulesIgnoredFix,
            ),
          )
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

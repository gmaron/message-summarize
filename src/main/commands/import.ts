import { statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { isValidAccountId } from '../../domain/account-id.js'
import { ALL_WEEKDAYS, makeSchedule, sameSchedule } from '../../domain/schedule.js'
import type { ImportSummary } from '../../infrastructure/i18n/index.js'
import {
  type LegacyLayout,
  legacyDatabaseExists,
  legacyInstanceExists,
  legacyLayoutOf,
  legacyLiveSignals,
  listLegacyInstances,
  looksLikeLegacyRoot,
  sessionAccount,
} from '../../infrastructure/legacy/summaryzing-whatsapp.js'
import type { ImportArgs } from '../../interfaces/cli/args.js'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../../interfaces/cli/run.js'
import { installationCatalog, isPrepared, prepareAccount } from '../account-command.js'
import { daemonUsing } from '../account-use.js'
import { type Installation, isDirectory, openInstallation } from '../accounts.js'
import { loadEffectiveConfig } from '../config.js'
import { type CommandContext, formatInstant, hasSession, maskAccount } from '../context.js'
import { acquireDaemonLock } from '../daemon-lock.js'
import { buildImport, importWorkDirName, mapLegacySettings, NoSessionError, PrivacyListError } from '../import.js'
import { IMPORT_LOCK, removeStaleImportDirs } from '../import-workdirs.js'
import { acquireLinkLock } from '../link-lock.js'
import { errorCode } from '../logger.js'
import { accountLayoutOf, FILE_MODE } from '../paths.js'
import { createRuntime } from '../runtime.js'

interface Plan {
  readonly instance: string | null
  readonly id: string
  readonly legacy: LegacyLayout
  /** How the user named it, for messages: the path, plus the instance. */
  readonly source: string
}

/** An instance name as an account id: lowercase, underscores as dashes. Null when the result is not a valid id. */
const deriveId = (name: string): string | null => {
  const id = name.toLowerCase().replaceAll('_', '-')
  return isValidAccountId(id) ? id : null
}

async function readRawConfig(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * `msum import --from <path> [--account <id>] [--instance <name>] [--all] [--schedule HH:MM,HH:MM] [--yes]` (RF-06):
 * brings an installation of the previous tool (summaryzing-whatsapp) in as an account, with its session (no QR to scan
 * again), its messages, unread state and last-digest pointer, its settings and its prompt. It only COPIES: the
 * previous installation is never modified.
 *
 * Safety:
 * - It refuses when the account already exists and is linked (or has data), when the running daemon uses it, when
 *   another process holds its link lock (which it takes itself, as `link` does), and when the previous tool looks
 *   alive (it keeps no lock or pid file: its database was written a moment ago).
 * - Before anything is copied it warns that one session must not run in two places, and asks (or `--yes`).
 * - It is atomic per account: everything is built in a hidden directory inside `accounts/`, which is then moved into
 *   place with ONE rename, and only then are the schedules added. Any failure leaves no account, no row and no files.
 *
 * Afterwards it opens what it built, offline, and prints a summary: counts, the settings written, the number (masked)
 * and what was left behind. It never prints a secret or a message.
 */
export async function importCommand(ctx: CommandContext, args: ImportArgs): Promise<number> {
  const { io, layout } = ctx
  const rootTexts = (await installationCatalog(ctx)).cli
  const texts = rootTexts.import
  const root = resolve(args.from)
  if (!(await looksLikeLegacyRoot(root))) {
    io.err(texts.notLegacy(root))
    return EXIT_USAGE
  }

  // What to import, each as its own account.
  const wanted: { instance: string | null; id: string }[] = []
  if (args.all) {
    wanted.push({ instance: null, id: 'default' })
    for (const name of await listLegacyInstances(root)) {
      const id = deriveId(name)
      if (id === null) {
        io.err(texts.invalidDerivedId(name))
        return EXIT_USAGE
      }
      wanted.push({ instance: name, id })
    }
  } else if (args.instance !== null) {
    if (!(await legacyInstanceExists(root, args.instance))) {
      io.err(texts.instanceNotFound(args.instance))
      return EXIT_USAGE
    }
    const id = args.account ?? deriveId(args.instance)
    if (id === null) {
      io.err(texts.invalidDerivedId(args.instance))
      return EXIT_USAGE
    }
    wanted.push({ instance: args.instance, id })
  } else {
    wanted.push({ instance: null, id: args.account ?? 'default' })
  }
  const seen = new Set<string>()
  for (const { id } of wanted) {
    if (seen.has(id)) {
      io.err(texts.duplicateId(id))
      return EXIT_USAGE
    }
    seen.add(id)
  }
  const plans: Plan[] = wanted.map(({ instance, id }) => ({
    instance,
    id,
    legacy: legacyLayoutOf(root, instance, args.data === null ? undefined : resolve(args.data)),
    source: instance === null ? root : `${root} (instancias/${instance})`,
  }))

  // The previous side: a session to take, its data where it should be, and nothing writing to it.
  for (const plan of plans) {
    if ((await sessionAccount(plan.legacy.authDir)) === null) {
      io.err(texts.noSession(plan.source))
      return EXIT_FAILURE
    }
    if (!args.sessionOnly && !(await legacyDatabaseExists(plan.legacy))) {
      io.err(texts.dataMissing(plan.source, plan.legacy.dbFile))
      return EXIT_FAILURE
    }
    if (!args.force) {
      const signals = await legacyLiveSignals(plan.legacy, Date.now())
      if (signals.length > 0) {
        io.err(texts.legacyLive(plan.source, signals))
        return EXIT_FAILURE
      }
    }
  }

  // This side: nothing replaced, nothing in use. Looked at before asking, so a refusal costs the user no question.
  const opened = await openInstallation({ layout, clock: ctx.clock })
  if (!opened.ok) {
    io.err(rootTexts.legacyDaemonRunning(opened.pid))
    return EXIT_FAILURE
  }
  try {
    // A copy of a session abandoned by an import that crashed is removed here (see `removeStaleImportDirs`).
    await removeStaleImportDirs(layout, ctx.logger)
    // The privacy lists (`soloLocal`, `excluir`) are never dropped silently: if one cannot be imported, nothing is.
    const baseline = await baselineConfig(ctx).catch(() => null)
    if (baseline === null) {
      io.err(rootTexts.config.heading)
      return EXIT_USAGE
    }
    const raw = await readRawConfig(layout.configFile)
    for (const plan of plans) {
      const { blocked } = await mapLegacySettings(plan.legacy, { raw, baseline })
      const first = blocked[0]
      if (first !== undefined) {
        io.err(texts.privacyList(plan.source, first.legacyKey, first.reason))
        return EXIT_FAILURE
      }
    }
    for (const plan of plans) {
      const refusal = await targetRefusal(ctx, plan.id)
      if (refusal !== null) {
        io.err(refusal)
        return EXIT_FAILURE
      }
    }
  } finally {
    opened.installation.close()
  }

  io.out(texts.warning(plans.map((plan) => `  ${plan.source}  ->  ${plan.id}`).join('\n')))
  if (!args.yes && !(await ctx.confirm(texts.confirm))) {
    io.err(texts.cancelled)
    return EXIT_FAILURE
  }

  for (const plan of plans) {
    const code = await importOne(ctx, plan, args)
    if (code !== EXIT_OK) return code
  }
  return EXIT_OK
}

/** Why an account cannot receive an import (linked, in use, with data), as the message to print, or null. */
async function targetRefusal(ctx: CommandContext, id: string): Promise<string | null> {
  const texts = (await installationCatalog(ctx)).cli.import
  const account = accountLayoutOf(ctx.layout, id)
  if (!isDirectory(account.dir)) return null
  const using = await daemonUsing(ctx.layout, account)
  if (using !== null) return texts.daemonUsing(id, using)
  if (await hasSession(account)) return texts.targetLinked(id)
  // Not linked, but with a database that holds messages: that is data an import must not replace.
  if (statSync(account.dbFile, { throwIfNoEntry: false })?.isFile() === true) {
    const runtime = createRuntime({
      layout: account,
      config: await baselineConfig(ctx),
      env: ctx.env,
      clock: ctx.clock,
      summarizer: null,
    })
    try {
      const row = runtime.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
      if (Number(row.n) > 0) return texts.targetHasData(id)
    } finally {
      runtime.close()
    }
  }
  return null
}

async function baselineConfig(ctx: CommandContext) {
  const loaded = await loadEffectiveConfig(ctx.layout.configFile, null)
  if (!loaded.ok) throw new Error('the installation configuration is not valid')
  return loaded.value
}

async function importOne(ctx: CommandContext, plan: Plan, args: ImportArgs): Promise<number> {
  const { io, layout } = ctx
  const prepared = await prepareAccount(ctx, plan.id, 'link')
  if (!isPrepared(prepared)) return prepared.exit
  const { installation, account, created, config, catalog } = prepared
  const texts = catalog.cli.import

  // The lock of the account, as `link` takes it: the daemon does not start it while the import works on it.
  const lock = await acquireLinkLock(account)
  if (!lock.ok) {
    installation.close()
    io.err(texts.beingLinked(plan.id, lock.pid, account.linkLockFile))
    return EXIT_FAILURE
  }
  const workDir = join(layout.accountsDir, importWorkDirName())
  let renamed = false
  let importLock: { release(): Promise<void> } | null = null
  try {
    await ctx.afterLock?.()
    // The checks that count, under the lock.
    const refusal = await targetRefusal(ctx, plan.id)
    if (refusal !== null) {
      io.err(refusal)
      return EXIT_FAILURE
    }

    io.out(texts.starting(plan.source, plan.id))
    const raw = await readRawConfig(layout.configFile)
    const baseline = await baselineConfig(ctx)
    // The work directory carries a pid file (the lock format) from the moment it exists: if this process dies, whoever
    // comes next can tell that the directory, which holds a copy of a WhatsApp session, is abandoned.
    await mkdir(workDir, { recursive: true, mode: 0o700 })
    const acquired = await acquireDaemonLock(join(workDir, IMPORT_LOCK))
    if (!acquired.ok) throw new Error('the work directory is already held')
    importLock = acquired
    const report = await buildImport({
      legacy: plan.legacy,
      workDir,
      installation: { raw, baseline },
      account,
      env: ctx.env,
      clock: ctx.clock,
      afterStep: ctx.afterImportStep,
      sessionOnly: args.sessionOnly,
    })
    await ctx.afterImportStep?.('built')

    // The lock of the account moves in with it: from the moment `accounts/<id>` holds a session until the import is
    // over or rolled back, a live `link.lock` is in it, so the daemon cannot start the account half way.
    await writeFile(join(workDir, basename(account.linkLockFile)), await readFile(account.linkLockFile), {
      mode: FILE_MODE,
    })
    // The one rename: what was built becomes the account. (An empty account made by an earlier attempt at linking is
    // what it replaces; anything else was refused above.)
    await rm(account.dir, { recursive: true, force: true })
    await rename(workDir, account.dir)
    renamed = true
    await rm(join(account.dir, IMPORT_LOCK), { force: true })
    await ctx.afterImportStep?.('renamed')

    // The schedules the user gave; the row of the account already exists.
    const existing = installation.schedules.list(plan.id).map((stored) => stored.schedule)
    for (const time of args.schedules) {
      const made = makeSchedule(ALL_WEEKDAYS, time)
      if (made.ok && !existing.some((other) => sameSchedule(other, made.value))) {
        installation.schedules.add(plan.id, made.value)
        existing.push(made.value)
      }
    }

    // Offline verification: open what was built and say what is in it.
    const summary = await verify(ctx, plan, config, report, installation.schedules.list(plan.id).length)
    io.out(texts.summary(summary))
    return EXIT_OK
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    // No partial account: what was moved into place is removed, and so is the account made for this run.
    await restoreAfterFailure(installation, plan.id, created, renamed)
    ctx.logger.error('import.failed', { account: plan.id, code: errorCode(error) })
    const first = error instanceof PrivacyListError ? error.blocked[0] : undefined
    if (first !== undefined) io.err(texts.privacyList(plan.source, first.legacyKey, first.reason))
    else
      io.err(error instanceof NoSessionError ? texts.noSession(plan.source) : texts.failed(plan.id, errorCode(error)))
    return EXIT_FAILURE
  } finally {
    installation.close()
    await importLock?.release().catch(() => undefined)
    await lock.release()
  }
}

async function restoreAfterFailure(
  installation: Installation,
  id: string,
  created: boolean,
  renamed: boolean,
): Promise<void> {
  try {
    if (renamed || created) await installation.deleteAccount(id)
    // An account that existed before (empty) is put back as it was: a row and an empty directory.
    if (!created) await installation.createAccount(id)
  } catch {
    // nothing more can be done here; the failure is already reported
  }
}

/** Opens the account that was built, offline, and checks it: the counts are what it holds, the number is the session's. */
async function verify(
  ctx: CommandContext,
  plan: Plan,
  config: Awaited<ReturnType<typeof baselineConfig>>,
  report: Awaited<ReturnType<typeof buildImport>>,
  schedules: number,
): Promise<ImportSummary> {
  const account = accountLayoutOf(ctx.layout, plan.id)
  const runtime = createRuntime({ layout: account, config, env: ctx.env, clock: ctx.clock, summarizer: null })
  try {
    const count = (table: string): number =>
      Number((runtime.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
    const bound = runtime.identity.get()
    if (bound === null || bound !== report.me) throw new Error('the account is not bound to the number of its session')
    const pointer = await runtime.store.getPointer()
    return {
      id: plan.id,
      source: plan.source,
      masked: maskAccount(bound),
      sessionFiles: report.sessionFiles,
      conversations: count('conversations'),
      participants: count('participants'),
      messages: count('messages'),
      skippedKinds: report.skippedKinds,
      excluded: report.excludedMessages,
      edited: report.edited,
      unreadCounted: report.unreadCounted,
      unreadMarked: report.unreadMarked,
      pointer: pointer === null ? null : formatInstant(pointer, await installationCatalog(ctx), config.timezone),
      configWritten: report.configWritten,
      configUnmapped: report.configUnmapped,
      configInvalid: report.configInvalid,
      promptCopied: report.promptCopied,
      schedules,
      mediaFiles: report.mediaFiles,
      imageTexts: report.imageTexts,
      transcribeErrors: report.transcribeErrors,
      pendingOutbox: report.pendingOutbox,
      digestFiles: report.digestFiles,
      otherState: report.otherState,
    }
  } finally {
    runtime.close()
  }
}

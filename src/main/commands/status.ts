import { existsSync } from 'node:fs'
import { getCatalog } from '../../infrastructure/i18n/index.js'
import { CronerScheduler } from '../../infrastructure/scheduling/croner-scheduler.js'
import type { AccountArg } from '../../interfaces/cli/args.js'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../../interfaces/cli/run.js'
import { installationCatalog } from '../account-command.js'
import { openInstallation } from '../accounts.js'
import { readBlocked } from '../blocked.js'
import { describeConfigIssue, languageHint, loadEffectiveConfig } from '../config.js'
import { type CommandContext, formatInstant, loadConfigOrReport, maskAccount } from '../context.js'
import { runningDaemonPid } from '../daemon-lock.js'
import { accountLayoutOf } from '../paths.js'
import { createRuntime } from '../runtime.js'

/**
 * `msum status`: where the data is, whether a daemon runs and, for each account (or the one of `--account`): its id and
 * linked number (masked), when the last digest ended, how many parts wait to be delivered, whether it is blocked and
 * the next run of each schedule. Never prints message content. It creates no account and no account database: with
 * no database yet it reports the account as not linked.
 */
export async function statusCommand(ctx: CommandContext, args: AccountArg): Promise<number> {
  const rootCatalog = await installationCatalog(ctx)
  const opened = await openInstallation({ layout: ctx.layout, clock: ctx.clock })
  if (!opened.ok) {
    ctx.io.err(rootCatalog.cli.legacyDaemonRunning(opened.pid))
    return EXIT_FAILURE
  }
  const { installation } = opened
  try {
    const { io, layout } = ctx
    const now = ctx.clock.now()
    const known = installation.accounts().map((row) => row.id)
    if (args.account !== null && !known.includes(args.account)) {
      io.err(rootCatalog.cli.accounts.unknown(args.account, known.join(', ')))
      return EXIT_USAGE
    }
    const shown = args.account === null ? known : [args.account]

    // The installation configuration is validated even when there is no account yet.
    if (shown.length === 0) {
      const root = await loadConfigOrReport(ctx)
      if (root === null) return EXIT_USAGE
      const texts = root.catalog.cli.status
      io.out(texts.dataDir(layout.dataDir))
      io.out(texts.noAccounts)
      io.out(texts.daemon(await runningDaemonPid(layout.lockFile)))
      return EXIT_OK
    }

    const lines: string[] = []
    let brokenConfig = false
    for (const [index, id] of shown.entries()) {
      const account = accountLayoutOf(layout, id)
      const loaded = await loadEffectiveConfig(layout.configFile, account.configFile)
      if (!loaded.ok) {
        // Every account is shown: one with an invalid configuration says why inside its own block.
        brokenConfig = true
        const broken = getCatalog(await languageHint(layout.configFile, account.configFile))
        const brokenTexts = broken.cli.status
        if (index === 0) {
          lines.push(brokenTexts.dataDir(layout.dataDir))
          lines.push(brokenTexts.daemon(await runningDaemonPid(layout.lockFile)))
        } else lines.push('')
        lines.push(brokenTexts.configBroken(id))
        lines.push(`  ${broken.cli.config.heading}`)
        for (const issue of loaded.error) lines.push(`    - ${describeConfigIssue(broken, issue)}`)
        continue
      }
      const config = loaded.value
      const catalog = getCatalog(config.language)
      const texts = catalog.cli.status

      let masked: string | null = null
      let pointer: number | null = null
      let pending = 0
      if (existsSync(account.dbFile)) {
        const runtime = createRuntime({ layout: account, config, env: ctx.env, clock: ctx.clock, summarizer: null })
        try {
          const bound = runtime.identity.get()
          masked = bound === null ? null : maskAccount(bound)
          pointer = await runtime.store.getPointer()
          pending = runtime.store.pendingOutbox().length
        } finally {
          runtime.close()
        }
      }

      if (index === 0) {
        lines.push(texts.dataDir(layout.dataDir))
        lines.push(texts.daemon(await runningDaemonPid(layout.lockFile)))
      } else lines.push('')
      lines.push(texts.account(id, masked))
      lines.push(texts.lastDigest(pointer === null ? null : formatInstant(pointer, catalog, config.timezone)))
      lines.push(texts.pending(pending))
      const blocked = await readBlocked(account.blockedFile)
      if (blocked !== null) {
        const when = blocked.at === 0 ? '-' : formatInstant(blocked.at, catalog, config.timezone)
        lines.push(texts.blocked(catalog.cli.blockedReasons[blocked.reason](id), when))
      }
      if (config.schedules.length === 0) lines.push(texts.noSchedules)
      const scheduler = new CronerScheduler({
        timezone: config.timezone,
        schedules: config.schedules,
        onTick: () => {},
      })
      for (const { schedule, next } of scheduler.nextRuns(new Date(now))) {
        lines.push(
          texts.schedule(schedule, next === null ? null : formatInstant(next.getTime(), catalog, config.timezone)),
        )
      }
    }
    for (const line of lines) io.out(line)
    return brokenConfig ? EXIT_USAGE : EXIT_OK
  } finally {
    installation.close()
  }
}

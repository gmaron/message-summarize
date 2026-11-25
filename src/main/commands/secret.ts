import {
  envNames,
  InvalidSecretsFileError,
  isPlausibleKey,
  KEY_PROVIDERS,
  type KeySource,
  removeApiKey,
  resolveApiKey,
  storeApiKey,
} from '../../infrastructure/secrets/index.js'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type SecretCommand } from '../../interfaces/cli/run.js'
import type { CommandContext } from '../context.js'
import { openInstallation } from '../installation/accounts.js'
import { accountLayoutOf, ensureDataDirs } from '../installation/paths.js'
import { installationCatalog } from './account-command.js'

/**
 * `msum secret set|rm <provider>` and `msum secret ls` (RNF-04). The keys live in `<data directory>/secrets.json`, or in
 * `accounts/<id>/secrets.json` with `--account`, written atomically with mode 0600.
 *
 * - `set` reads the key from the input: hidden when it is a terminal, or piped. Never from an argument (it would show in
 *   `ps` and the shell history), and the key is never printed, not even partly.
 * - `ls` says which providers have a key and where it comes from (environment variable, account file or file).
 * The precedence is: environment, then the file of the account, then the file of the installation.
 */
export async function secretCommand(ctx: CommandContext, command: SecretCommand): Promise<number> {
  const { io, layout } = ctx
  const catalog = await installationCatalog(ctx)
  const texts = catalog.cli.secret

  let accountFile: string | undefined
  if (command.account !== null) {
    const opened = await openInstallation({ layout, clock: ctx.clock })
    if (!opened.ok) {
      io.err(catalog.cli.legacyDaemonRunning(opened.pid))
      return EXIT_FAILURE
    }
    try {
      const known = opened.installation.accounts().map((row) => row.id)
      if (!known.includes(command.account)) {
        io.err(catalog.cli.accounts.unknown(command.account, known.join(', ')))
        return EXIT_USAGE
      }
    } finally {
      opened.installation.close()
    }
    accountFile = accountLayoutOf(layout, command.account).secretsFile
  }
  const file = accountFile ?? layout.secretsFile

  const describe = (source: KeySource | null): string => {
    if (source === null) return texts.sourceNone
    if (source.kind === 'env') return texts.sourceEnv(source.name)
    return source.kind === 'accountFile' ? texts.sourceAccountFile(source.file) : texts.sourceFile(source.file)
  }

  if (command.action === 'ls') {
    io.out(texts.header)
    const width = Math.max(...KEY_PROVIDERS.map((provider) => provider.length))
    for (const provider of KEY_PROVIDERS) {
      const found = resolveApiKey(provider, { env: ctx.env, accountFile, file: layout.secretsFile })
      io.out(texts.row(provider.padEnd(width), describe(found?.source ?? null)))
    }
    io.out(texts.precedence)
    return EXIT_OK
  }

  try {
    if (command.action === 'rm') {
      const removed = await removeApiKey(file, command.provider)
      io.out(removed ? texts.removed(command.provider, file) : texts.notStored(command.provider, file))
      return EXIT_OK
    }

    const key = (await ctx.readSecret(texts.keyPrompt(command.provider))).trim()
    if (key === '') {
      io.err(texts.emptyKey)
      return EXIT_FAILURE
    }
    if (!isPlausibleKey(key)) {
      io.err(texts.invalidKey)
      return EXIT_FAILURE
    }
    await ensureDataDirs(layout)
    await storeApiKey(file, command.provider, key)
    io.out(texts.stored(command.provider, file))
    const overriding = envNames(command.provider).filter((name) => (ctx.env[name] ?? '') !== '')
    if (overriding.length > 0) io.out(texts.envWins(overriding.join(', ')))
    return EXIT_OK
  } catch (error) {
    if (error instanceof InvalidSecretsFileError) {
      io.err(texts.invalidFile(error.file))
      return EXIT_FAILURE
    }
    throw error
  }
}

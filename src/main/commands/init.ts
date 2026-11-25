import { writeFile } from 'node:fs/promises'
import { getCatalog } from '../../infrastructure/i18n/index.js'
import { EXIT_FAILURE, EXIT_OK } from '../../interfaces/cli/run.js'
import { defaultConfigJson, languageHint, systemTimezone } from '../config/config.js'
import type { CommandContext } from '../context.js'
import { ensureDataDirs, FILE_MODE } from '../installation/paths.js'
import { ensureWebToken } from '../web/token.js'

/**
 * `msum init`: creates the data directory, the access token of the local web and a default config.json. An existing
 * configuration (or token) is never touched.
 */
export async function initCommand(ctx: CommandContext): Promise<number> {
  const { layout, io } = ctx
  const texts = getCatalog(await languageHint(layout.configFile)).cli
  try {
    await ensureDataDirs(layout)
  } catch {
    io.err(texts.cannotCreateDataDir(layout.dataDir))
    return EXIT_FAILURE
  }
  await ensureWebToken(layout)
  const timezone = systemTimezone()
  try {
    await writeFile(layout.configFile, defaultConfigJson(timezone), { flag: 'wx', mode: FILE_MODE })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    io.out(texts.init.exists(layout.configFile))
    return EXIT_OK
  }
  io.out(texts.init.created(layout.dataDir, layout.configFile, timezone))
  io.out(texts.init.next)
  return EXIT_OK
}

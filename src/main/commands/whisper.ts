import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  downloadModel,
  findModel,
  MODEL_HOST,
  modelFileName,
  WHISPER_MODELS,
} from '../../infrastructure/transcription/index.js'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type WhisperCommand } from '../../interfaces/cli/run.js'
import { installationCatalog } from '../account-command.js'
import type { CommandContext } from '../context.js'
import { ensureDataDirs } from '../paths.js'

/** 148 MB, 3.1 GB: what a person reads. Decimal units, as the download pages show them. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}

const isFile = async (path: string): Promise<boolean> => (await stat(path).catch(() => null))?.isFile() === true

/**
 * `msum whisper models` and `msum whisper download <name>` (RF-22, CLI half).
 *
 * - `models` lists the models of the pinned table with their size, and marks the ones in the models directory of the
 *   installation. It does not touch the network.
 * - `download` fetches one into `<data directory>/models/` (see `downloadModel`: the checksum is verified against the
 *   pinned one, the file is written atomically, and a bad download leaves nothing behind) and prints a progress line at
 *   every tenth of the file. It is the only command that contacts a host, and only this one (RNF-01).
 */
export async function whisperCommand(ctx: CommandContext, command: WhisperCommand): Promise<number> {
  const { io, layout } = ctx
  const texts = (await installationCatalog(ctx)).cli.whisper
  const table = ctx.whisperModels ?? WHISPER_MODELS
  const known = table.map((entry) => entry.name).join(', ')

  if (command.action === 'models') {
    const nameWidth = Math.max(...table.map((model) => model.name.length))
    const sizes = table.map((model) => formatBytes(model.bytes))
    const sizeWidth = Math.max(...sizes.map((size) => size.length))
    io.out(texts.modelsHeader)
    for (const [index, model] of table.entries()) {
      const installed = await isFile(join(layout.modelsDir, modelFileName(model.name)))
      io.out(texts.modelRow(model.name.padEnd(nameWidth), (sizes[index] ?? '').padStart(sizeWidth), installed))
    }
    io.out(texts.modelsHint(layout.modelsDir))
    return EXIT_OK
  }

  const model = findModel(command.model, table)
  if (model === undefined) {
    io.err(texts.unknownModel(command.model, known))
    return EXIT_USAGE
  }
  await ensureDataDirs(layout)
  io.out(texts.downloading(model.name, formatBytes(model.bytes), MODEL_HOST))
  let lastTenth = 0
  const result = await downloadModel(model.name, {
    modelsDir: layout.modelsDir,
    table,
    ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }),
    onProgress: ({ received, total }) => {
      const tenth = Math.floor((received / total) * 10)
      if (tenth <= lastTenth) return
      lastTenth = tenth
      io.out(texts.progress(tenth * 10, formatBytes(received), formatBytes(total)))
    },
  })
  if (result.ok) {
    io.out(
      result.value.alreadyThere
        ? texts.alreadyThere(model.name, result.value.path)
        : texts.done(model.name, result.value.path),
    )
    io.out(texts.enableHint(model.name))
    return EXIT_OK
  }
  const { error } = result
  switch (error.kind) {
    case 'unknownModel':
      io.err(texts.unknownModel(command.model, known))
      return EXIT_USAGE
    case 'http':
      io.err(texts.httpError(error.status))
      break
    case 'network':
      io.err(texts.networkError)
      break
    case 'size':
      io.err(texts.sizeError)
      break
    case 'checksum':
      io.err(texts.checksumError)
      break
    case 'write':
      io.err(texts.writeError(layout.modelsDir))
      break
  }
  return EXIT_FAILURE
}

import { totalmem } from 'node:os'
import {
  bytesToGb,
  fitsRam,
  isOnMachine,
  OLLAMA_CANDIDATES,
  passesRf45,
  pullOllamaModel,
  recommendCandidate,
} from '../../infrastructure/llm/index.js'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type OllamaCommand } from '../../interfaces/cli/run.js'
import { installationCatalog, isPrepared, prepareAccount } from '../account-command.js'
import type { CommandContext } from '../context.js'
import { originOf } from './provider.js'
import { formatBytes } from './whisper.js'

const percent = (rate: number): string => `${Math.round(rate * 100)}%`

const TAG_CHARS = /^[A-Za-z0-9._\-/:]{1,200}$/

/**
 * What a tag may be: letters, digits and `. _ - / :` (`hf.co/user/model:Q4_K_M` is one), with no `..` or `//`, and no
 * `/`, `:`, `.` or `-` at either end. A guard against typos and odd paths, not a full grammar.
 */
export const isValidTag = (tag: string): boolean =>
  TAG_CHARS.test(tag) &&
  !tag.includes('..') &&
  !tag.includes('//') &&
  /^[A-Za-z0-9].*[A-Za-z0-9_]$|^[A-Za-z0-9]$/.test(tag)

/**
 * `msum ollama recommend` and `msum ollama pull <tag>` (RF-45, CLI half).
 *
 * - `recommend` reads the RAM of this machine and picks from the table of candidates (`OLLAMA_CANDIDATES`). While no
 *   candidate that fits has a committed passing evaluation it says plainly that the choice is provisional. It makes no
 *   network call.
 * - `pull` asks the configured Ollama to download a model. It sends only the tag, never chat text, and only to an
 *   Ollama on this machine unless `--allow-remote` is given. The error text of the server is redacted.
 */
export async function ollamaCommand(ctx: CommandContext, command: OllamaCommand): Promise<number> {
  if (command.action === 'recommend') return recommend(ctx)
  return pull(ctx, command)
}

async function recommend(ctx: CommandContext): Promise<number> {
  const texts = (await installationCatalog(ctx)).cli.ollama
  const { io } = ctx
  const totalBytes = ctx.totalMemBytes ?? totalmem()
  const recommendation = recommendCandidate(totalBytes)

  io.out(texts.ramLine(bytesToGb(totalBytes).toFixed(0)))
  io.out(texts.candidatesHeader)
  for (const candidate of OLLAMA_CANDIDATES) {
    const evaluation =
      candidate.evaluated && candidate.result !== undefined
        ? texts.evaluationDone(
            candidate.result.date,
            percent(candidate.result.validJsonRate),
            percent(candidate.result.needsReplyAgreement),
            passesRf45(candidate.result),
          )
        : texts.evaluationNone
    io.out(
      texts.candidateRow(
        candidate.tag,
        candidate.parameters,
        `${candidate.downloadGb.toFixed(1)} GB`,
        `${candidate.minRamGb} GB`,
        fitsRam(candidate, totalBytes),
        evaluation,
      ),
    )
  }
  if (recommendation === null) {
    io.out(texts.noneFits(Math.min(...OLLAMA_CANDIDATES.map((candidate) => candidate.minRamGb))))
    return EXIT_OK
  }
  io.out(texts.recommended(recommendation.candidate.tag))
  if (recommendation.provisional) {
    io.out(texts.provisional)
    io.out(texts.provisionalHint)
  }
  io.out(texts.nextSteps(recommendation.candidate.tag))
  return EXIT_OK
}

async function pull(ctx: CommandContext, command: Extract<OllamaCommand, { action: 'pull' }>): Promise<number> {
  const prepared = await prepareAccount(ctx, command.account, 'existing')
  if (!isPrepared(prepared)) return prepared.exit
  try {
    const texts = prepared.catalog.cli.ollama
    const { io } = ctx
    const { baseUrl } = prepared.config.provider.ollama
    if (!isValidTag(command.tag)) {
      io.err(texts.invalidTag(command.tag))
      return EXIT_USAGE
    }
    if (!isOnMachine(baseUrl) && !command.allowRemote) {
      io.err(texts.remoteRefused(originOf(baseUrl)))
      return EXIT_FAILURE
    }
    io.out(texts.pulling(command.tag, originOf(baseUrl)))
    let lastTenth = -1
    let lastStatus = ''
    const result = await pullOllamaModel(baseUrl, command.tag, {
      ...(ctx.fetch === undefined ? {} : { fetch: ctx.fetch }),
      onProgress: ({ status, completed, total }) => {
        if (total > 0) {
          const tenth = Math.min(10, Math.floor((completed / total) * 10))
          if (tenth > lastTenth) {
            lastTenth = tenth
            io.out(texts.progress(tenth * 10, formatBytes(completed), formatBytes(total)))
          }
        }
        // The layers announce "pulling <digest>": the percentage says it. The steps around them are worth a line.
        if (!status.startsWith('pulling ') && status !== lastStatus) {
          lastStatus = status
          io.out(texts.status(status))
        }
      },
    })
    if (!result.ok) {
      io.err(texts.failed(result.error))
      return EXIT_FAILURE
    }
    io.out(texts.done(command.tag))
    io.out(texts.doneHint(command.tag))
    return EXIT_OK
  } finally {
    prepared.installation.close()
  }
}

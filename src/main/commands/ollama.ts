import { totalmem } from 'node:os'
import {
  bytesToGb,
  isOnMachine,
  listCandidates,
  OLLAMA_CANDIDATES,
  pullOllamaModel,
} from '../../infrastructure/llm/index.js'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type OllamaCommand } from '../../interfaces/cli/run.js'
import type { CommandContext } from '../context.js'
import { installationCatalog, isPrepared, prepareAccount } from './account-command.js'
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
 * - `recommend` reads the RAM of this machine and lists the candidates that fit (`OLLAMA_CANDIDATES`; `--all` also the
 *   others), the ones that passed the evaluation first. The user chooses: nothing is picked or written, and it makes no
 *   network call.
 * - `pull` asks the configured Ollama to download a model. It sends only the tag, never chat text, and only to an
 *   Ollama on this machine unless `--allow-remote` is given. The error text of the server is redacted.
 */
export async function ollamaCommand(ctx: CommandContext, command: OllamaCommand): Promise<number> {
  if (command.action === 'recommend') return recommend(ctx, command.all)
  return pull(ctx, command)
}

async function recommend(ctx: CommandContext, all: boolean): Promise<number> {
  const texts = (await installationCatalog(ctx)).cli.ollama
  const { io } = ctx
  const totalBytes = ctx.totalMemBytes ?? totalmem()
  const listed = listCandidates(totalBytes, { all })

  io.out(texts.ramLine(bytesToGb(totalBytes).toFixed(0)))
  if (listed.length === 0) {
    io.out(texts.noneFits(Math.min(...OLLAMA_CANDIDATES.map((candidate) => candidate.minRamGb))))
  } else {
    io.out(texts.candidatesHeader)
    for (const { candidate, fits } of listed) {
      const evaluation =
        candidate.evaluated && candidate.result !== undefined
          ? texts.evaluationDone(
              candidate.result.date,
              percent(candidate.result.validJsonRate),
              percent(candidate.result.needsReplyAgreement),
              `${(candidate.result.meanLatencyMs / 1000).toFixed(1)} s`,
              candidate.result.passed,
            )
          : texts.evaluationNone
      io.out(
        texts.candidateRow(
          candidate.tag,
          `${candidate.downloadGb.toFixed(1)} GB`,
          `${candidate.minRamGb} GB`,
          fits,
          evaluation,
        ),
      )
    }
  }
  const hidden = all ? 0 : OLLAMA_CANDIDATES.length - listed.length
  if (hidden > 0) io.out(texts.hidden(hidden))
  io.out(texts.choose)
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

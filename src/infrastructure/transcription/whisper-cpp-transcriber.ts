import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscribeFailure, TranscribeRequest, Transcriber } from '../../application/ports/transcriber.js'
import { err, ok, type Result } from '../../domain/result.js'
import { type RunningProcess, type RunOutcome, runProcess } from './run-process.js'

export interface WhisperCppOptions {
  /** The whisper.cpp command line program. Default `whisper-cli`. */
  readonly whisperCommand?: string
  /** Converts the audio to the format whisper reads. Default `ffmpeg`. */
  readonly ffmpegCommand?: string
  /** Absolute path of the ggml model. Null: none is configured, and nothing can be transcribed (RF-21). */
  readonly modelPath: string | null
  /** Total time for one audio, conversion included (RF-20). Default 5 minutes. */
  readonly timeoutMs?: number
  /** Time between SIGTERM and SIGKILL when a limit fires. Default 5 seconds. */
  readonly killGraceMs?: number
  /** Where the environment of the programs is taken from. Default `process.env` (only a few names are used). */
  readonly env?: NodeJS.ProcessEnv
  /** Where the temporary working directories go. Default the system's. */
  readonly tmpRoot?: string
}

export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 5 * 60_000

/** What a language setting may be: `auto`, or a two or three letter ISO 639 code. Nothing else reaches the command line. */
export const LANGUAGE_PATTERN = /^(auto|[a-z]{2,3})$/

/** The longest audio read, in seconds: more is cut (ffmpeg `-t`). */
export const MAX_AUDIO_SECONDS = 1800
/** The most ffmpeg may write (`-fs`): 30 minutes of 16 kHz mono 16-bit PCM, plus 5% of margin. */
export const MAX_WAV_BYTES = Math.ceil(MAX_AUDIO_SECONDS * 16_000 * 2 * 1.05)

/**
 * The ffmpeg input format (`-f`) of an audio file, from its extension: the audio formats of WhatsApp, and nothing else. A
 * file that sends any other thing never reaches ffmpeg.
 */
const INPUT_FORMATS: Readonly<Record<string, string>> = {
  ogg: 'ogg',
  mp3: 'mp3',
  m4a: 'mov', // the demuxer of the MP4 family
  aac: 'aac',
  amr: 'amr',
}

export function inputFormatOf(path: string): string | undefined {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase()
  return extension !== undefined && Object.hasOwn(INPUT_FORMATS, extension) ? INPUT_FORMATS[extension] : undefined
}

/**
 * The exact ffmpeg command line. The audio comes from a stranger, so ffmpeg is held down:
 * - `-nostdin`: it never waits for the terminal.
 * - `-protocol_whitelist file`: the input can only be a file (no network, no `concat:` tricks), whatever the container says.
 * - `-f <format>`: the input format is forced, never guessed from the bytes.
 * - `-t 1800`: reads at most 30 minutes. `-fs`: writes at most `MAX_WAV_BYTES`, so a hostile file cannot fill the disk.
 * The input is an absolute path, so it cannot be read as an option.
 */
export function ffmpegArgs(format: string, input: string, output: string): string[] {
  return [
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'file',
    '-f',
    format,
    '-t',
    String(MAX_AUDIO_SECONDS),
    '-i',
    input,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    '-fs',
    String(MAX_WAV_BYTES),
    output,
  ]
}

/** How a failed program is described: its exit code and the end of what it said. Never the transcript. */
const describeExit = (program: string, outcome: Extract<RunOutcome, { kind: 'exited' }>): string => {
  const tail = outcome.stderr.trim().split('\n').slice(-3).join(' | ').slice(-300)
  return `${program} exited with code ${outcome.code}${tail === '' ? '' : `: ${tail}`}`
}

/**
 * Transcribes with whisper.cpp (RF-20): the audio is converted to 16 kHz mono WAV with ffmpeg (as the previous tool did,
 * since WhatsApp voice notes are Ogg Opus), then `whisper-cli` writes the text to a file, which is read and tidied
 * (whitespace collapsed, as the previous tool did).
 *
 * Everything runs on this machine and nothing opens a network connection. Both programs run with no shell, in an empty
 * temporary directory, with a restricted environment and under one time limit that kills their whole process group.
 * A program or the model that is missing is `unavailable`, not a failure of the audio (RF-21).
 */
export class WhisperCppTranscriber implements Transcriber {
  private readonly whisperCommand: string
  private readonly ffmpegCommand: string
  private readonly timeoutMs: number
  private readonly running = new Set<RunningProcess>()
  private closed = false

  constructor(private readonly options: WhisperCppOptions) {
    this.whisperCommand = options.whisperCommand ?? 'whisper-cli'
    this.ffmpegCommand = options.ffmpegCommand ?? 'ffmpeg'
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS
  }

  async close(): Promise<void> {
    this.closed = true
    for (const child of [...this.running]) child.kill()
  }

  async transcribe(request: TranscribeRequest): Promise<Result<string, TranscribeFailure>> {
    if (this.closed) return err({ kind: 'unavailable', reason: 'closed' })
    const { modelPath } = this.options
    if (modelPath === null) return err({ kind: 'unavailable', reason: 'no-model' })
    if (!(await isFile(modelPath))) return err({ kind: 'unavailable', reason: 'model-missing' })
    if (!(await isFile(request.audioPath))) return err({ kind: 'failed', reason: 'audio-missing' })
    if (!LANGUAGE_PATTERN.test(request.language)) return err({ kind: 'failed', reason: 'invalid-language' })
    // The format is forced from the file name (which the downloader set from the mimetype), so ffmpeg never guesses it.
    const format = inputFormatOf(request.audioPath)
    if (format === undefined) return err({ kind: 'failed', reason: 'unsupported-format' })

    const startedAt = Date.now()
    const remaining = (): number => Math.max(1, this.timeoutMs - (Date.now() - startedAt))
    const dir = await mkdtemp(join(this.options.tmpRoot ?? tmpdir(), 'message-summarize-whisper-'))
    try {
      const wav = join(dir, 'audio.wav')
      const converted = await this.run(
        'ffmpeg',
        this.ffmpegCommand,
        ffmpegArgs(format, request.audioPath, wav),
        dir,
        remaining(),
      )
      if (!converted.ok) return converted

      const base = join(dir, 'transcript')
      const transcribed = await this.run(
        'whisper',
        this.whisperCommand,
        // -nt: no timestamps, -np: nothing but results on the output, -otxt -of: the text goes to <base>.txt.
        ['-m', modelPath, '-l', request.language, '-f', wav, '-nt', '-np', '-otxt', '-of', base],
        dir,
        remaining(),
      )
      if (!transcribed.ok) return transcribed

      let text: string
      try {
        text = await readFile(`${base}.txt`, 'utf8')
      } catch {
        return err({ kind: 'failed', reason: 'whisper wrote no transcript' })
      }
      return ok(text.replace(/\s+/g, ' ').trim())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private async run(
    program: 'ffmpeg' | 'whisper',
    command: string,
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<Result<true, TranscribeFailure>> {
    if (this.closed) return err({ kind: 'unavailable', reason: 'closed' })
    const child = runProcess({
      command,
      args,
      cwd,
      timeoutMs,
      ...(this.options.killGraceMs === undefined ? {} : { killGraceMs: this.options.killGraceMs }),
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
    })
    this.running.add(child)
    let outcome: RunOutcome
    try {
      outcome = await child.result
    } finally {
      this.running.delete(child)
    }
    switch (outcome.kind) {
      case 'timeout':
        return err({ kind: 'timeout' })
      case 'killed':
        return err({ kind: 'unavailable', reason: 'closed' })
      case 'spawn-error':
        // Not installed (ENOENT) or not executable (EACCES): the audio is fine, the machine is not ready.
        return err({
          kind: 'unavailable',
          reason: `${program}-${outcome.code === 'ENOENT' ? 'missing' : outcome.code}`,
        })
      case 'exited':
        return outcome.code === 0 ? ok(true) : err({ kind: 'failed', reason: describeExit(program, outcome) })
    }
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

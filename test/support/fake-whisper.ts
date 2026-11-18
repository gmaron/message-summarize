import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allowSubprocess } from './network-guard.js'

/**
 * Stand-ins for `ffmpeg` and `whisper-cli`: small shell scripts in a temp directory, so the tests exercise the real
 * adapter (arguments, process handling, files) without whisper.cpp, ffmpeg or a model. Nothing here reaches the network.
 *
 * - The fake ffmpeg copies its input (the argument after `-i`) to its output (its last argument).
 * - The fake whisper writes the CONTENT of the file it is given (`-f`) as the transcript to `<-of>.txt`: a test chooses the
 *   transcript by choosing what is in the audio file.
 * - Both log every call (the arguments, one line per call) next to the script; the fake whisper also logs its working
 *   directory and its environment.
 * - `setWhisperMode` changes what the next call of whisper does.
 */
export type WhisperMode = 'ok' | 'fail' | 'hang' | 'no-output'

// Shell built-ins only (no dirname, cat, cp): every program started is a cost on a loaded machine, and a test run
// starts these scripts dozens of times. The audio "files" of the tests are text, so copying them line by line is exact.
const FFMPEG = `#!/bin/sh
dir=\${0%/*}
echo "$@" >> "$dir/ffmpeg.log"
if [ -f "$dir/ffmpeg-mode" ]; then
  read -r mode < "$dir/ffmpeg-mode"
  if [ "$mode" = fail ]; then
    echo "Invalid data found when processing input" >&2
    exit 1
  fi
fi
while [ $# -gt 1 ]; do
  if [ "$1" = "-i" ]; then input="$2"; fi
  shift
done
while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < "$input" > "$1"
`

const WHISPER = `#!/bin/sh
dir=\${0%/*}
echo "$@" >> "$dir/whisper.log"
pwd >> "$dir/whisper.cwd"
if [ -f "$dir/log-env" ]; then env > "$dir/whisper.env"; fi
mode=ok
if [ -f "$dir/mode" ]; then read -r mode < "$dir/mode"; fi
while [ $# -gt 0 ]; do
  case "$1" in
    -f) file="$2"; shift 2;;
    -of) base="$2"; shift 2;;
    *) shift;;
  esac
done
case "$mode" in
  fail) echo "whisper_init_from_file: failed to load model" >&2; exit 3;;
  hang)
    echo $$ > "$dir/whisper.pid"
    sleep 30 &
    echo $! > "$dir/whisper.child.pid"
    wait;;
  no-output) exit 0;;
esac
while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < "$file" > "$base.txt"
`

export interface FakeWhisper {
  readonly dir: string
  /** A directory for the transcriber's temporary working directories, so a test can check that it is left clean. */
  readonly tmpRoot: string
  readonly whisper: string
  readonly ffmpeg: string
  /** A file that stands for the ggml model (its content never matters). */
  readonly model: string
  setWhisperMode(mode: WhisperMode): void
  setFfmpegFails(fails: boolean): void
  /** One line per call: the arguments, as the program received them. */
  whisperCalls(): string[]
  ffmpegCalls(): string[]
  /** The working directory of each whisper call. */
  whisperCwds(): string[]
  /** Makes the fake whisper write its environment down (off by default: it costs a program start). */
  logEnv(): void
  /** What the environment of the last whisper call was, as `NAME=value` lines (after `logEnv()`). */
  whisperEnv(): string[]
  /** The pid of the last hanging whisper and of the `sleep` it started. */
  hangingPids(): { whisper: number; child: number }
  /** Writes an audio file (any name) whose content is the transcript the fake whisper will produce. */
  audio(name: string, transcript: string): string
  /** Lets the test guard allow starting this path (a program that is missing or not executable: the start must fail). */
  allow(path: string): string
  dispose(): void
}

const lines = (file: string): string[] => {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
  } catch {
    return []
  }
}

export function installFakeWhisper(): FakeWhisper {
  const dir = mkdtempSync(join(tmpdir(), 'msum-fake-whisper-'))
  const tmpRoot = join(dir, 'tmp')
  mkdirSync(tmpRoot)
  const audioDir = join(dir, 'audio')
  mkdirSync(audioDir)
  const whisper = join(dir, 'whisper-cli')
  const ffmpeg = join(dir, 'ffmpeg')
  const model = join(dir, 'ggml-fake.bin')
  writeFileSync(whisper, WHISPER)
  writeFileSync(ffmpeg, FFMPEG)
  writeFileSync(model, 'not a real model')
  chmodSync(whisper, 0o755)
  chmodSync(ffmpeg, 0o755)
  const revoke = [allowSubprocess(whisper), allowSubprocess(ffmpeg)]
  return {
    dir,
    tmpRoot,
    whisper,
    ffmpeg,
    model,
    setWhisperMode: (mode) => writeFileSync(join(dir, 'mode'), mode),
    setFfmpegFails: (fails) => writeFileSync(join(dir, 'ffmpeg-mode'), fails ? 'fail' : 'ok'),
    whisperCalls: () => lines(join(dir, 'whisper.log')),
    ffmpegCalls: () => lines(join(dir, 'ffmpeg.log')),
    whisperCwds: () => lines(join(dir, 'whisper.cwd')),
    logEnv: () => writeFileSync(join(dir, 'log-env'), ''),
    whisperEnv: () => lines(join(dir, 'whisper.env')),
    hangingPids: () => ({
      whisper: Number(readFileSync(join(dir, 'whisper.pid'), 'utf8').trim()),
      child: Number(readFileSync(join(dir, 'whisper.child.pid'), 'utf8').trim()),
    }),
    audio: (name, transcript) => {
      const path = join(audioDir, name)
      writeFileSync(path, transcript)
      return path
    },
    allow: (path) => {
      revoke.push(allowSubprocess(path))
      return path
    },
    dispose: () => {
      for (const undo of revoke) undo()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** True while a process with this pid exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

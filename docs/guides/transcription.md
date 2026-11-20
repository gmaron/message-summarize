# Transcribing voice notes (optional)

It ships turned off. This guide explains what it does, how to turn it on and its limits. Back to the [README](../../README.md).

## What it does

When it is on:

- Voice notes and audio that arrive **while the daemon is connected**, and those from the **last 14 days of the history** that WhatsApp sends when linking (`historyAudioDays`; older ones stay as `🎤 (audio not transcribed)`), are downloaded from WhatsApp to `accounts/<id>/media/` (0700 directory, 0600 files).
- They are transcribed **on your machine** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp).
- The digest shows the text where it would say `🎤 (audio not transcribed)`.
- The audio is never sent to any service.
- **What is kept is the text:** the audio file is deleted as soon as it is transcribed, or fails for good. `msum unlink` deletes whatever remains, along with the rest of the account.

With transcription off, or if whisper, ffmpeg or the model is missing, **everything else works the same** and audio shows up as `🎤 (audio not transcribed)`; `msum doctor` says what is missing. An audio that cannot be transcribed is recorded as failed and is not retried.

## How to turn it on

1. **Install whisper.cpp**, which provides the `whisper-cli` program (for example `brew install whisper-cpp` on macOS, or build it from source following its README on Linux).
2. **Install ffmpeg** (`brew install ffmpeg`, `apt install ffmpeg`...): it converts the audio to the format whisper reads.
3. **Download a model:** `msum whisper models` lists the known ggml models with their size, and `msum whisper download base` downloads one to `<data directory>/models/`, showing progress and verifying a SHA-256 checksum pinned in the program. A file that does not match is discarded and nothing is left behind. `base` and `small` are a good start for voice notes; larger models are more accurate and slower.
4. **Enable it** in `config.json` (or in an account's own file):

   ```json
   "transcription": { "enabled": true, "model": "base", "language": "auto" }
   ```

## Options

| Option | Default | What it means |
|---|---|---|
| `enabled` | `false` | Turns transcription on. |
| `model` | none | The name of a model in `<data directory>/models/` (`base`, `small.en`...), or the path of a ggml file. |
| `language` | `auto` | `auto` detects each audio's language; or a code such as `es` or `en`. Each account can have its own. |
| `whisperCommand` | `whisper-cli` | The whisper.cpp program (a name in `PATH`, or a path). |
| `ffmpegCommand` | `ffmpeg` | The ffmpeg program. |
| `timeoutMs` | `300000` | The most an audio can take, ffmpeg included. A program that takes longer is killed. |
| `historyAudioDays` | `14` | Audio from the history of the last N days is also downloaded and transcribed. |
| `maxMediaMb` | `500` | The most that an account's downloaded audio can take together, in MB. |

## Limits, because the audio comes from other people

- Downloads come only from WhatsApp's media server, and only for a message that carries a plain WhatsApp media path. Anything else the sender writes in the message (an address, a server) is ignored and the audio is recorded as failed (`invalid-media-path`).
- A file over 25 MB is not downloaded; a download is cut at 60 seconds; and the audio an account keeps on disk cannot exceed `maxMediaMb` (500 by default; past that limit new ones are rejected, `media-cap`, and `msum doctor` warns beforehand).
- Only WhatsApp's audio formats are converted (Ogg Opus voice notes, MP3, M4A/MP4, AAC, AMR). ffmpeg runs with the input format forced, can only read a file (`-protocol_whitelist file`), reads at most 30 minutes (`-t 1800`) and writes at most about 60 MB (`-fs`).

### Nothing is lost on a restart

- Audio waiting to be downloaded sits in a queue stored in the account's database (with what is needed to download each one), and the daemon walks it one at a time, oldest to newest: a first link with hundreds of audio files just takes longer, and memory holds one audio at a time.
- A download interrupted by a stop, a restart or a dropped connection stays in the queue and resumes.
- A transient download failure is retried with a growing wait (30 seconds, then 1, 2 and 4 minutes: 5 attempts), and then the audio is recorded as failed (`download-failed`).
- An audio pending for more than 30 days is abandoned (`expired`), like a file WhatsApp no longer has. One that is too large or a full folder fail immediately.
- The key to decrypt each file lives only in that database while it waits, and is deleted as soon as the file is saved or the download fails for good; it is never written to the logs.

## One whisper at a time

**One whisper at a time in the whole program,** no matter how many accounts there are: audio is transcribed in the background, in order, as it arrives. Right before each digest, the audio in its window that is still waiting is transcribed first, and the digest waits for it at most two minutes: whatever is not ready comes out as not transcribed and is finished afterwards.

### `msum digest` and the daemon

- While the daemon runs, it owns transcription: `msum digest` does not run whisper, it only waits (at most the same two minutes) for the daemon to finish the audio in its window.
- Without a daemon, `msum digest` transcribes on its own.
- This also holds for `--dry-run`: a transcript is captured data, like a message, not a result of the digest, so a preview may save it, and still it does not move the pointer nor write anything to the history or the delivery queue.

## How the programs run

The programs run without a shell, in an empty temporary directory, with a minimal environment, and are killed if they exceed the time limit. If the daemon itself is killed with `SIGKILL` nobody can kill them for it (Node cannot ask the system for that), so an audio in progress finishes on its own; a normal stop (Ctrl+C, `SIGTERM`) does kill them.

---

Back to the [README](../../README.md) · [Guides index](README.md)

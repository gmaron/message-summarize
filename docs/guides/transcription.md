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
| `historyAudioDays` | `14` | Audio from the history of the last N days is also downloaded and transcribed. **`0` means no limit: the whole history** (a full history can bring thousands of audio files; see [A full history](#a-full-history-many-audio-files-in-parallel)). |
| `maxMediaMb` | `500` | The most that an account's downloaded audio can take together, in MB. |
| `concurrency` | `1` | How many transcriptions run at once (1 to 16), each one a separate `whisper-cli` process. |
| `threads` | `1` | Threads (`-t`) of each `whisper-cli` process (1 to 64). |
| `downloadConcurrency` | `2` | How many audio downloads run at once (1 to 16). |

## Limits, because the audio comes from other people

- Downloads come only from WhatsApp's media server, and only for a message that carries a plain WhatsApp media path. Anything else the sender writes in the message (an address, a server) is ignored and the audio is recorded as failed (`invalid-media-path`).
- A file over 25 MB is not downloaded; a download is cut at 60 seconds; and the audio an account keeps on disk cannot exceed `maxMediaMb` (500 by default; past that limit new ones are rejected, `media-cap`, and `msum doctor` warns beforehand).
- Only WhatsApp's audio formats are converted (Ogg Opus voice notes, MP3, M4A/MP4, AAC, AMR). ffmpeg runs with the input format forced, can only read a file (`-protocol_whitelist file`), reads at most 30 minutes (`-t 1800`) and writes at most about 60 MB (`-fs`).

### Nothing is lost on a restart

- Audio waiting to be downloaded sits in a queue stored in the account's database (with what is needed to download each one), and the daemon walks it oldest to newest, up to `downloadConcurrency` at a time: a first link with hundreds of audio files just takes longer, and memory holds only the audio being downloaded.
- A download interrupted by a stop, a restart or a dropped connection stays in the queue and resumes.
- A transient download failure is retried with a growing wait (30 seconds, then 1, 2 and 4 minutes: 5 attempts), and then the audio is recorded as failed (`download-failed`).
- There is no age limit on a pending audio: one whose file WhatsApp no longer has is requested again from your phone (see below) and is recorded as failed (`expired`) only if that does not work. One that is too large or a full folder fail immediately.
- The key to decrypt each file lives only in that database while it waits, and is deleted as soon as the file is saved or the download fails for good; it is never written to the logs.

## How audio is transcribed

By default **one whisper at a time in the whole program** (`concurrency: 1`), no matter how many accounts there are. With `concurrency` greater than 1, up to that many run at once in the whole program, each one a separate process. Audio is transcribed in the background, **newest first** (what just arrived is read first), as soon as it is downloaded: it does not wait for a digest. Right before each digest, the audio in its window that is still waiting is transcribed first (oldest first), and the digest waits for it at most two minutes: whatever is not ready comes out as not transcribed and is finished afterwards.

The queue lives in the account's database. A transcriber takes the next pending audio and marks it as in progress in a single step, so two of them never get the same one. If the process stops, the audio in progress goes back to the queue when it starts again, and the work resumes where it was.

## A full history: many audio files, in parallel

Linking an account with its full history (`historyAudioDays: 0`) can bring thousands of audio files. A setup for a machine that has to get through them:

```json
"transcription": {
  "enabled": true, "model": "large-v3-turbo-q5_0", "language": "es",
  "historyAudioDays": 0, "concurrency": 8, "threads": 1, "downloadConcurrency": 4
}
```

- **CPUs:** about `concurrency × threads`. `concurrency` is worth more than `threads`: several audio files at once use the CPU better than one with many threads. For example, with 8 CPUs, `concurrency: 8, threads: 1` (or `concurrency: 4, threads: 2`).
- **RAM:** about **1 GB per concurrent transcription** with `large-v3-turbo-q5_0` (so `concurrency: 10` asks for about 10 GB, plus the rest of the program). With less RAM, lower `concurrency`. If you run the daemon in a container (a sandbox), give it those CPUs and that memory, or the system will kill whisper processes.
- Memory stays bounded: downloads and transcriptions take rows from the database one at a time, never the whole queue.
- Progress: every 60 seconds, if it changed, the daemon logs `transcription.stats` with counts only (`pending`, `downloading`, `running`, `done`, `failed`, `reuploadRequested`).

### Old audio: asked again from your phone

WhatsApp deletes the media from its servers after a few weeks, so the audio of an old history answers "gone" (404 or 410). For **audio only**, the program then uses the standard feature of any linked device: it asks **your own phone** to upload the file again (a media retry request addressed to your own account; it sends nothing to anyone else and does not touch the conversation). When the phone answers, the download goes on.

- At most one request starts every 2 seconds.
- Each audio is requested at most 4 times (with a growing wait of 1, 4 and 16 minutes if the phone does not answer); after that, or if the phone says it does not have the file either, it is recorded as failed (`expired`) and shows as not transcribed.
- The phone has to be on and online for it to answer. Audio that arrived in the last weeks does not need this.

### `msum digest` and the daemon

- While the daemon runs, it owns transcription: `msum digest` does not run whisper, it only waits (at most the same two minutes) for the daemon to finish the audio in its window.
- Without a daemon, `msum digest` transcribes on its own.
- This also holds for `--dry-run`: a transcript is captured data, like a message, not a result of the digest, so a preview may save it, and still it does not move the pointer nor write anything to the history or the delivery queue.

## How the programs run

The programs run without a shell, in an empty temporary directory, with a minimal environment, and are killed if they exceed the time limit. If the daemon itself is killed with `SIGKILL` nobody can kill them for it (Node cannot ask the system for that), so an audio in progress finishes on its own; a normal stop (Ctrl+C, `SIGTERM`) does kill them.

---

Back to the [README](../../README.md) · [Guides index](README.md)

# message-summarize

[Español](README.es.md)

Reads the messages that arrive at your messaging account, summarizes them with the language model of your choice and sends you a periodic digest: which chats need a reply, what is still pending and what you can safely ignore.

The first supported platform is **WhatsApp**. The core does not depend on it, so other platforms (Telegram, Slack, email) can be added later as new adapters.

## Status

**Early development.** There is no installer and no web interface yet. A command-line version can be tried from source (see [Try it](#try-it-early-version)); expect rough edges. The approved requirements are in [docs/requirements.md](docs/requirements.md) (in Spanish) and the work is organized in the phases of the [roadmap](#roadmap).

## Try it (early version)

**Read the [warning](#important-warning) first: this uses an unofficial WhatsApp client and your number can be banned.** The program is read-only: it never marks you as online, never replies and never sends anything except the digest, which goes to your own chat ("Message yourself").

Requirements: Node 22.16 or later, and one LLM provider: [Claude Code](https://claude.com/claude-code) signed in on this machine (`claude`), or a local [Ollama](https://ollama.com) server with a model already pulled. There is no default provider: you choose one in the configuration.

```sh
npm install
npm run build
node dist/main/cli.js init      # or `msum init` after `npm link`; creates the data directory and config.json
```

1. **Edit `config.json`** (in the data directory that `init` prints; set `MSUM_DATA_DIR` to put it elsewhere). There is no default provider: `init` writes `"primary": null`, and **you must set `provider.primary` explicitly** (`"claude-cli"` or `"ollama"`; with Ollama also set `provider.ollama.model`) before `digest` or the schedules work. Also check your `timezone` (`init` prints the one it wrote, the system's; **in Docker, set `TZ` or `timezone` in the config**), and your `ownerName`. The times of the digests are not in this file any more: see `msum schedule` below. A relative `promptFile` is read from the directory of the file that sets it (the data directory for `config.json`, `accounts/<id>/` for an account's own file). Invalid values are rejected with a message that names the option.
2. **`msum link`** shows a QR code in the terminal (also saved as `qr.png` while it is valid). Scan it from WhatsApp, Settings > Linked devices. It waits for the initial history and stops.
3. **`msum daemon`** connects every account, captures messages, runs the schedules and delivers each digest to that account's own chat. Leave it running (Ctrl+C stops it cleanly). Only one daemon runs per installation, and it runs ALL the accounts: each one is isolated (its own connection, schedules, missed-run catch-up and delivery), so an account that is blocked or fails does not stop the others; a failure inside one account restarts only that account, with a growing wait. `msum daemon --account <id>` runs just that one account: it is for debugging. If WhatsApp logs a session out, refuses (403) or replaces the connection, or the session belongs to another number, the daemon stops connecting THAT account, writes `accounts/<id>/blocked.json` and keeps it idle (so a service manager that restarts the daemon does not reconnect in a loop, which could get the number banned). An account with nothing linked is left idle too: no connection is opened for it. `msum status` shows why, and the connection state of each account while the daemon runs. To fix a block: `msum retry --account <id>` for a refused or replaced connection (the running daemon picks the account up again within seconds), or link again for a session that is no good (`msum unlink --account <id>`, then `msum link --account <id>`). `msum daemon --retry` clears, before starting, exactly the blocks `msum retry` clears (a dead session stays blocked). A block is never lifted by itself: a missing `blocked.json` counts as "cleared" only if the daemon knows it was on disk. If an account's connection keeps failing (5 failures in a row, with growing waits, and a unit that stays connected for 10 minutes starts the count over), the daemon stops trying and blocks it (`socketFailed`) instead of looping; `msum retry` brings it back. An account whose configuration is invalid, or that has schedules and no provider, is reported and left idle while the other accounts run (the daemon refuses to start only if `--account` names such an account, or every account is like that).

The daemon keeps looking at the installation while it runs: an account you link later starts by itself, a removed one stops, and a cleared block is retried. You can run `msum link --account <new-id>` while the daemon runs: the account is locked against the daemon while it is being linked (`accounts/<id>/link.lock`), and the daemon starts it only after the link finishes. `msum link` and `msum unlink` refuse an account the daemon is using (linked and not blocked), because it owns its session: stop the daemon first. Accounts it is not using (not linked, or blocked) can be linked or unlinked while it runs.

Several accounts can live in one installation: `msum link --account work` creates and links one (ids are lowercase letters, digits and dashes), `msum accounts` lists them, and `link`, `unlink`, `digest`, `daemon`, `status` and `doctor` take `--account <id>` (optional while there is a single account; `status` and `doctor` cover every account without it). Each account may have its own `config.json` in `accounts/<id>/` that overrides the one in the data directory: its top-level options replace the installation's, `provider` merges key by key, and the privacy lists `localOnlyPatterns` and `excludePatterns` are added to the installation's (never replaced), so an account can only make them stricter. `msum unlink --account work` deletes only that account's data. An installation from before this layout (`account/`) is moved to `accounts/default/` automatically, with no daemon running.
**Schedules.** Each account runs its digests on days of the week at a local time, kept in the database and managed with `msum schedule` (add `--account <id>` when there is more than one account):

- `msum schedule ls` lists them with their id, days, time and next run in the account's time zone.
- `msum schedule add --time 09:00 [--days daily|weekdays|weekends|mon,wed,fri|mon-fri]` adds one (every day if `--days` is left out). Day names work in English and Spanish (`lun`, `mar`, `mie`/`mié`, `jue`, `vie`, `sab`/`sáb`, `dom`).
- `msum schedule rm <id>` removes one of that account's schedules. To change a time, remove it and add the new one.

A running daemon picks the changes up within about five seconds, with no restart. These commands work while the daemon runs. Times follow the account's `timezone` and its daylight saving changes: a time that does not exist on the day of a clock change runs at the first valid time after it, and a time that happens twice runs once. A missed run (the machine was off) is made up once when the daemon starts. `msum init` writes no schedules and a new account starts with none, so no digest runs on its own until you add one (`msum link` and `msum doctor` remind you). For configurations written by earlier versions, the `schedules` option of `config.json` (cron expressions, in the installation's file or an account's) is still imported once per account, the first time the account is used: the times it can express (a fixed time on any days of the week) become schedules; the others are not imported, and `msum doctor` lists them as a warning. After that the option is ignored (`doctor` warns, and you can delete it), so a schedule you remove does not come back, and `config.json` is never rewritten. The option accepts any list of texts, so an old value never stops the configuration from loading.

4. **`msum digest --dry-run`** generates a digest now and prints it, without saving or sending anything. Without `--dry-run` the digest is queued and the running daemon delivers it. It does not open a WhatsApp connection (the daemon owns the session). Options: `--hours N`, `--from "YYYY-MM-DD HH:MM"`, `--to "YYYY-MM-DD HH:MM"`.

Other commands: `msum status` (account, last digest, pending deliveries, next runs), `msum doctor` (checks Node, permissions, configuration, provider, link and, when it is on, transcription), `msum whisper models|download <name>` (see [Transcribe voice notes](#transcribe-voice-notes-optional)) and `msum unlink`, which **deletes all the data of the account** (its messages, the audios it downloaded, the digest history, pending deliveries and the WhatsApp session; the configuration stays) and asks for confirmation. Afterwards, also remove the device on the phone (WhatsApp, Settings > Linked devices).

Everything stays on your machine, in the data directory (permissions restricted to your user), except what the LLM provider you chose receives. The command-line texts are in Spanish or English (`language` in `config.json`).

## Transcribe voice notes (optional)

Off by default. When it is on, the voice notes and audios that arrive **while the daemon is connected**, and those of the **last 14 days of history** that WhatsApp sends when you link (`historyAudioDays`; older ones stay as `🎤 (audio not transcribed)`), are downloaded from WhatsApp into `accounts/<id>/media/` (directory 0700, files 0600), transcribed **on your machine** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and the digest shows the text where it would say `🎤 (audio not transcribed)`. The audio is never sent to any service. **What is kept is the text:** the audio file is deleted as soon as it is transcribed, or has failed for good. `msum unlink` deletes anything left, with the rest of the account.

With transcription off, or with whisper, ffmpeg or the model missing, **everything else works the same** and audios show as `🎤 (audio not transcribed)`; `msum doctor` says what is missing. An audio that cannot be transcribed is recorded as failed and not tried again.

**Limits, because the audio comes from other people:**

- Downloads only come from WhatsApp's own media host, and only for a message that carries a plain WhatsApp media path; anything else the sender writes in the message (an address, a host) is ignored and the audio is recorded as failed (`invalid-media-path`).
- A file bigger than 25 MB is not downloaded; a download is cut after 60 seconds; and the audios an account keeps on disk may not exceed `maxMediaMb` (500 by default; past it new ones are refused, `media-cap`, and `msum doctor` warns before that).
- **Nothing is lost to a restart.** The audios to download wait in a queue kept in the account's database (with what it takes to download each one), and the daemon works through it one at a time, oldest first: a first link with hundreds of audios just takes a while, and memory holds one audio at a time. A download cut short by a stop, a restart or a dropped connection stays queued and is resumed. A network failure is tried again on the next sweep (every 30 seconds), up to 5 times, and then the audio is recorded as failed (`download-failed`); media that WhatsApp no longer has (`expired`), a file that is too big or a full folder fail at once. The decryption key of each file lives only in that database while it waits, and is deleted as soon as the file is stored or the download has failed for good; it is never written to the logs.
- Only the audio formats of WhatsApp (Ogg Opus voice notes, MP3, M4A/MP4, AAC, AMR) are converted. ffmpeg runs with its input format forced, only able to read a file (`-protocol_whitelist file`), reading at most 30 minutes (`-t 1800`) and writing at most about 60 MB (`-fs`).

To turn it on:

1. **Install whisper.cpp**, which provides the `whisper-cli` program (for example `brew install whisper-cpp` on macOS, or build it from source following its README on Linux).
2. **Install ffmpeg** (`brew install ffmpeg`, `apt install ffmpeg`...): it converts the audio to the format whisper reads.
3. **Download a model:** `msum whisper models` lists the known ggml models with their sizes, and `msum whisper download base` downloads one into `<data directory>/models/`, showing its progress and verifying a pinned SHA-256 checksum. A file that does not match is discarded and nothing is left behind. `base` and `small` are a good start for voice notes; bigger models are more accurate and slower.
4. **Turn it on** in `config.json` (or in an account's own file):

   ```json
   "transcription": { "enabled": true, "model": "base", "language": "auto" }
   ```

   | Option | Default | Meaning |
   |---|---|---|
   | `enabled` | `false` | Turns transcription on. |
   | `model` | none | A model name in `<data directory>/models/` (`base`, `small.en`...), or the path of a ggml file. |
   | `language` | `auto` | `auto` detects the language of each audio; or a code such as `es` or `en`. Each account can have its own. |
   | `whisperCommand` | `whisper-cli` | The whisper.cpp program (a name on the `PATH`, or a path). |
   | `ffmpegCommand` | `ffmpeg` | The ffmpeg program. |
   | `timeoutMs` | `300000` | The most one audio may take, ffmpeg included. A program that takes longer is killed. |
   | `historyAudioDays` | `14` | Audios of the history of the last N days are downloaded and transcribed too. |
   | `maxMediaMb` | `500` | The most the downloaded audios of an account may take together, in MB. |

**One whisper at a time in the whole program,** however many accounts there are: audios are transcribed in the background, in order, as they arrive. Right before each digest, the audios of its window that are still waiting are transcribed first, and the digest waits for them for at most two minutes: what is not ready goes out as not transcribed and is finished afterwards.

**`msum digest` and the daemon.** While the daemon runs, it owns the transcription: `msum digest` does not run whisper, it only waits (the same two minutes at most) for the daemon to finish the audios of its window. Without a daemon, `msum digest` transcribes by itself. This also holds for `--dry-run`: a transcript is captured data, like a message, not a result of the digest, so a preview may store it, and it still moves no pointer and writes nothing to the history or to the outbox.

The programs run with no shell, in an empty temporary directory, with a minimal environment, and are killed if they exceed the time limit. If the daemon itself is killed with `SIGKILL` nothing can kill them for it (Node cannot ask the system for that), so a running audio finishes by itself; a normal stop (Ctrl+C, `SIGTERM`) kills them.

## What the program connects to

Nothing is sent anywhere except:

- **WhatsApp**, through the connection of your own account (including the download of the audios you receive, when transcription is on).
- **The LLM provider you chose** (and, with Ollama, the URL you configured).
- **Hugging Face, only when you run `msum whisper download <name>`:** the model is fetched from the official whisper.cpp repository, `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<name>.bin`. Hugging Face answers with a redirect to its content network: a request to that URL ends at **`us.aws.cdn.hf.co`** (checked with a `HEAD` request when this was written). The program follows redirects itself, one at a time, and only to `https` addresses on `huggingface.co` or `*.hf.co`; any other host is refused. Nothing is sent but the request for that file, and the **checksum (SHA-256) and size of every model are pinned in the program**: a file that does not match is discarded.

There is no telemetry, and transcription never opens a network connection.

## Import from the previous tool

If you ran the previous installation of this idea (the summaryzing-whatsapp tool), `msum import --from <path>` brings it in without scanning the QR code again. It only **copies**: the previous installation is never modified, so it stays as a way back.

- **What it takes:** the WhatsApp session (byte for byte, private: directory 0700, files 0600), the messages with their edits, transcripts and read marks, the unread state of each chat, the contacts and their names, the pointer of the last digest (so the first digest does not summarize the past again), the settings (mapped to this program's options, writing only what differs from your `config.json`) and the prompt (`{{nombre}}` becomes `{{name}}`). The account is bound to the number of the session, so digests only go to that number's own chat.
- **What it does not take, and says so:** audio and image files (only their text and transcripts), the text read from images, transcription errors, digests waiting in the outbox, the saved digest files, the options without an equivalent here (image reading, Whisper, the web), and its internal state. They are counted in the summary.
- **Schedules:** the previous tool kept them outside its data (the cron of its sandbox, or launchd), so they cannot be read from the folder. Give the times with `--schedule 07:00,19:00`, or add them later with `msum schedule add`.
- **Which account:** `--account <id>` (default `default`) names the account for the main installation. `--instance <name>` imports one of its instances (`instancias/<name>/`, another phone) under that name, and `--all` imports the main installation and every instance, each as its own account.
- **Before you run it, stop the previous tool.** The same WhatsApp session must not run in two places at once, or WhatsApp disconnects one of them. The command warns you and asks for confirmation (or `--yes`), and it refuses while the previous tool looks as if it is running (it keeps no lock file, so this is inferred, only from file metadata): a `whatsapp.db-wal` or `-shm` next to its database (SQLite removes them when the last connection closes cleanly), its database written within the last minute, or its session files written within the last ten minutes. The message says which sign fired; stopping the previous tool clears them, and `--force` skips the check (the warning and the question remain). If both do run, the daemon blocks the account as `replaced` (see `msum retry`) instead of fighting for it.
- **Safe to run:** it refuses an account that is already linked or has data (unlink it first) or that the running daemon is using, and it is all-or-nothing per account: everything is built aside and moved into place with one rename, so a failure leaves no account and no files. Afterwards it opens what it built, offline, and prints a summary with the number masked.

- **Where its data is:** if the previous tool kept its data somewhere else (`WA_DATA_DIR`), the import refuses and says so; point to it with `--data <dir>` (only read). `--session-only` brings just the session, the settings and the prompt, without messages.
- **Privacy lists are never dropped silently:** your `excluir` chats are never stored here (RF-14; the summary counts what was left out), and if `soloLocal` (chats that must never leave your computer) cannot be imported, for example because no Ollama model is set, the whole import is refused and says what to fix.
- **Crashes:** the import works in a hidden `accounts/.import-*` directory with a pid file; one left by a crash is removed by the next import or when the daemon starts, and `msum doctor` reports it (it holds a copy of a session). While the import runs, the account's lock moves in with it, so a running daemon never starts the account half way.

Then check with `msum digest --dry-run --account <id>` and start the daemon.

## What it will do

- **Link your account** by scanning a QR code from a local web page, and keep it connected without marking you as "online", so your phone keeps getting notifications.
- **Store your messages only on your machine** (text, and a text representation of images, audio, documents, polls, etc.). No telemetry.
- **Transcribe voice notes locally** with whisper.cpp (optional). Audio never leaves your machine.
- **Summarize each conversation** with the LLM you choose:
  - through an **API**: OpenAI (and any compatible API), Anthropic, Gemini or Ollama;
  - through the provider's own **CLI** (Claude Code, Gemini CLI, Codex or a generic command), using the plan you already pay for. CLIs run with tools disabled, in an empty directory and with a time limit.
- **Mark conversations as "local only"** so they are only ever summarized by a model running on your machine.
- **Send the digest to your own chat** ("Message yourself"), sorted into sections: needs a reply, has pending items, everything else. It is never sent to anyone else, not even to another account in the same installation.
- **Run on a schedule** you set from the web (for example, 9:00 and 19:00 every day), plus "summarize now" and a preview that does not send anything.
- **Handle several accounts** in one installation, each with its own data, settings and schedules.
- **Install with Docker, or natively on macOS and Linux.** Native Windows comes in v1.1; until then, Windows uses Docker.

## Important warning

Read this before using message-summarize with your account.

- **Your number can be banned.** message-summarize connects to WhatsApp through [Baileys](https://github.com/WhiskeySockets/Baileys), an **unofficial** client. WhatsApp does not allow unofficial clients and may block the number that uses them, temporarily or permanently. The project tries to reduce that risk (read-only behavior, no messages to third parties, not marking itself online), but it cannot remove it.
- **Modifying the program or misusing it makes a ban more likely.** Changes that send messages to other people, send many messages, automate replies or change how the client connects can get your number blocked. If you change the code, you take that risk.
- **Your chats go to the LLM you choose.** Unless you use a local model (Ollama) or mark a conversation as "local only", the text of your conversations is sent to the provider you configure, under that provider's terms. Some free plans may use that content to improve their products, including human review.
- **You are responsible** for complying with WhatsApp's terms, your LLM provider's terms and the privacy of the people who write to you.

This project is not affiliated with, endorsed by or sponsored by WhatsApp or Meta.

## Roadmap

| Phase | Goal |
|---|---|
| 0 | Reference tests (golden files) that capture the behavior of the author's current personal tool, using made-up conversations |
| 1 | Domain and digest generation; WhatsApp source and delivery to your own chat |
| 2 | Daemon, schedules, multiple accounts and import from the personal tool |
| 3 | LLM providers (API and CLI), fallback provider, local-only conversations, whisper.cpp transcription and `doctor` |
| 4 | Local web: setup wizard, QR linking, dashboard, settings, history and logs |
| 5 | Packaging: Docker image, native installers for macOS and Linux, system service |
| 6 | CI, license checks, documentation and the first release (v0.1.0) |

## License

[MIT](LICENSE)

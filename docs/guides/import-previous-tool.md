# Importing from the previous tool

If you used the previous installation of this idea (the summaryzing-whatsapp tool), `msum import --from <path>` brings it over without scanning the QR again. It only **copies**: the previous installation is never modified, so it stays as a way back. Back to the [README](../../README.md).

## What it takes and what it does not

**What it takes:**

- the WhatsApp session (byte for byte, private: 0700 directory, 0600 files);
- the messages with their edits, transcripts and read marks;
- each chat's unread state, the contacts and their names;
- the last digest pointer (so the first digest does not summarize the past again);
- the configuration (translated to this program's options, writing only what differs from your `config.json`);
- the prompt (`{{nombre}}` becomes `{{name}}`).

The account is tied to the session's number, so digests only go to that number's own chat.

**What it does not take, and it says so:**

- audio and image files (only their texts and transcripts);
- text read from images and transcription errors;
- the digests that were waiting in the delivery queue and the saved digest files;
- options with no equivalent here (image reading, Whisper, the web) and its internal state.

They are counted in the summary.

## Options

| Option | What it does |
|---|---|
| `--from <path>` | The previous installation. |
| `--account <id>` | Names the account of the main installation (`default` by default). |
| `--instance <name>` | Imports one of its instances (`instancias/<name>/`, another phone) under that name. |
| `--all` | Imports the main installation and all instances, each as its own account. |
| `--schedule 07:00,19:00` | Gives the digest times (see below). |
| `--data <dir>` | Where the previous tool's data is, if it is not the usual place (`WA_DATA_DIR`). Read only. |
| `--session-only` | Brings only the session, the configuration and the prompt, no messages. |
| `--yes` | Skips the confirmation. |
| `--force` | Skips the check that the previous tool is running (the warning and the question stay). |

**Schedules.** The previous tool stored them outside its data (its sandbox's cron, or launchd), so they cannot be read from the folder. Pass the times with `--schedule 07:00,19:00`, or add them later with `msum schedule add`.

**Where its data is.** If the previous tool kept its data elsewhere (`WA_DATA_DIR`), the import refuses and says so; point to it with `--data <dir>`.

## Before running it: stop the previous tool

The same WhatsApp session cannot run in two places at once, or WhatsApp disconnects one of them. The command warns you and asks for confirmation (or `--yes`), and refuses while the previous tool seems to be running. It keeps no lock file, so this is deduced only from file metadata:

- a `whatsapp.db-wal` or `-shm` next to its database (SQLite deletes them when the last connection closes);
- its database written in the last minute;
- its session files written in the last ten minutes.

The message says which signal fired; stopping the previous tool makes them go away, and `--force` skips the check. If both run, the daemon blocks the account as `replaced` (see `msum retry` in [the daemon](daemon-and-schedules.md#blocks)) instead of fighting over it.

## Safety and privacy

- **Safe to run:** it refuses an account that is already linked or has data (unlink it first) or that the running daemon is using, and it is all or nothing per account: it builds everything aside and moves it into place with a single rename, so a failure leaves no account or files behind. When it ends it opens what it built, offline, and prints a summary with the number masked.
- **Privacy lists are never dropped silently:** your `excluir` chats are not stored here (RF-14; the summary counts what was left out), and if `soloLocal` (chats that must never leave your computer) cannot be imported, for example because there is no Ollama model, the whole import is rejected and it says what to fix.
- **Crashes:** the import works in a hidden `accounts/.import-*` directory with a pid file. What a crash leaves behind is deleted by the next import or by the daemon's start, and `msum doctor` reports it (it holds a copy of a session). While the import runs, the account's lock travels with it, so a running daemon never starts the account half-built.

## Afterwards

Check it with `msum digest --dry-run --account <id>` and start the daemon.

---

Back to the [README](../../README.md) · [Guides index](README.md)

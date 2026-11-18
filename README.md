# message-summarize

[Español](README.es.md)

Reads the messages that arrive at your messaging account, summarizes them with the language model of your choice and sends you a periodic digest: which chats need a reply, what is still pending and what you can safely ignore.

The first supported platform is **WhatsApp**. The core does not depend on it, so other platforms (Telegram, Slack, email) can be added later as new adapters.

## Status

**Early development.** There is no installer yet. A command-line version with a first local web page can be tried from source (see [Try it](#try-it-early-version)); expect rough edges. The approved requirements are in [docs/requirements.md](docs/requirements.md) (in Spanish) and the work is organized in the phases of the [roadmap](#roadmap).

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

Several accounts can live in one installation: `msum link --account work` creates and links one (ids are lowercase letters, digits and dashes), `msum accounts` lists them, and `link`, `unlink`, `digest`, `daemon`, `status` and `doctor` take `--account <id>` (optional while there is a single account; `status` and `doctor` cover every account without it). Each account may have its own `config.json` in `accounts/<id>/` that overrides the one in the data directory: its top-level options replace the installation's, `provider` merges key by key, and the privacy lists `localOnlyPatterns` and `excludePatterns` are added to the installation's (never replaced), so an account can only make them stricter. A pattern is a case-insensitive piece of `<id> <name>` ("ana" also matches "Mariana"), except `id:<conversation id>`, which matches that one conversation id exactly (it is what the web page writes when you mark a chat, because a plain id such as `5491112345678@s.whatsapp.net` is also contained in `15491112345678@s.whatsapp.net`). `msum unlink --account work` deletes only that account's data. An installation from before this layout (`account/`) is moved to `accounts/default/` automatically, with no daemon running.
**Schedules.** Each account runs its digests on days of the week at a local time, kept in the database and managed with `msum schedule` (add `--account <id>` when there is more than one account):

- `msum schedule ls` lists them with their id, days, time and next run in the account's time zone.
- `msum schedule add --time 09:00 [--days daily|weekdays|weekends|mon,wed,fri|mon-fri]` adds one (every day if `--days` is left out). Day names work in English and Spanish (`lun`, `mar`, `mie`/`mié`, `jue`, `vie`, `sab`/`sáb`, `dom`).
- `msum schedule rm <id>` removes one of that account's schedules. To change a time, remove it and add the new one.

A running daemon picks the changes up within about five seconds, with no restart. These commands work while the daemon runs. Times follow the account's `timezone` and its daylight saving changes: a time that does not exist on the day of a clock change runs at the first valid time after it, and a time that happens twice runs once. A missed run (the machine was off) is made up once when the daemon starts. `msum init` writes no schedules and a new account starts with none, so no digest runs on its own until you add one (`msum link` and `msum doctor` remind you). For configurations written by earlier versions, the `schedules` option of `config.json` (cron expressions, in the installation's file or an account's) is still imported once per account, the first time the account is used: the times it can express (a fixed time on any days of the week) become schedules; the others are not imported, and `msum doctor` lists them as a warning. After that the option is ignored (`doctor` warns, and you can delete it), so a schedule you remove does not come back, and `config.json` is never rewritten. The option accepts any list of texts, so an old value never stops the configuration from loading.

4. **`msum digest --dry-run`** generates a digest now and prints it, without saving or sending anything. Without `--dry-run` the digest is queued and the running daemon delivers it. It does not open a WhatsApp connection (the daemon owns the session). Options: `--hours N`, `--from "YYYY-MM-DD HH:MM"`, `--to "YYYY-MM-DD HH:MM"`.

Other commands: `msum status` (account, last digest, pending deliveries, next runs), `msum doctor` (checks Node, permissions, configuration, provider and link) and `msum unlink`, which **deletes all the data of the account** (its messages, the digest history, pending deliveries and the WhatsApp session; the configuration stays) and asks for confirmation. Afterwards, also remove the device on the phone (WhatsApp, Settings > Linked devices).

**Web page.** While the daemon runs it also serves a local page, by default at `http://127.0.0.1:8787` (option `web` in the installation's `config.json`: `port`, `host`, `enabled`). `msum open` opens it already signed in: the address carries an access token, generated once in the data directory (`web-token`), so do not share it. From the page you can add an account and link it by scanning the QR code, follow the sync of the history, see the state of each account and fix a block (link again, or retry: after a refused or replaced connection the page makes you wait 30 minutes), edit the schedules, run "summarize now" and see a preview that sends nothing and does not move the pointer. It also lists and searches the conversations of an account and marks each one as excluded or local only. You can also edit the prompt of each account (only `{{name}}` is a variable, the format of the response is fixed and added automatically) and go back to the original, which keeps your text in `prompt.previous.md`. **Excluding a chat deletes the messages and the chat row stored so far**; it does not remove the summaries already inside past digests (the history of digests is kept) nor the parts already queued for delivery. Un-excluding restores nothing. A mark covers the ids of that person that WhatsApp has told this computer about (a number and an internal id); if the same person shows up as a second chat, mark that one too. "Local only" needs an Ollama model in the settings. It listens only on this machine; another `host` (for example `0.0.0.0` inside Docker, publishing the port only on `127.0.0.1`) is an explicit choice. The "Logs" button shows the daemon's recent log lines, filterable by level and account; they never include messages, names or secrets. The daemon also writes them to `logs/daemon.log` in the data directory (rotated to `daemon.log.1`), and the two files together stay under `logs.maxBytes` (installation `config.json` only, 50 MB by default, minimum 1 MB). **Setup wizard.** The first time the page opens on an installation with no linked account, it starts a wizard (language, your name, provider, audio, link the phone by QR with the sync, first schedule). It can be closed halfway and resumed (its state is kept in `app.db`), or skipped; an installation that already has a linked account (made with the command line or `msum import`) never sees it. Choosing the provider shows what each one costs, whether data leaves your computer, to whom and what the provider does with it, and has a "Test connection" button that makes one real call with a short made-up chat (it only runs when you click it). A provider that sends the text of your chats out of this machine (today, Claude Code, which sends it to Anthropic under your Claude account) needs an explicit agreement: the box has to be ticked and it is recorded (account, provider, version of the text and time) in `app.db`. The settings ask for the same agreement the first time you pick such a provider for an account; Ollama on your own machine needs none, but an Ollama server whose address is not on this machine (not `localhost`, `127.0.0.0/8` or `::1`) counts as an external recipient too: the page names the host, says that "local only" conversations also go there, and asks for the same agreement. A configuration written by hand or with the command line is not blocked by this: the agreement is about the choice made in the web. The wizard is also the only place where the web writes the installation's `config.json`, and only its `language`. The other providers (API keys, Gemini, Codex, any other command) and local audio transcription come in a next version. Settings, conversations, the prompt, the history, the logs and the setup are all in the web.

Everything stays on your machine, in the data directory (permissions restricted to your user), except what the LLM provider you chose receives. The command-line texts are in Spanish or English (`language` in `config.json`).

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

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
3. **`msum daemon`** connects, captures messages, runs the schedules and delivers each digest to your own chat. Leave it running (Ctrl+C stops it cleanly). Only one daemon runs per installation. If WhatsApp logs the session out, refuses (403) or replaces the connection, or the session belongs to another account, the daemon stops connecting, writes `accounts/<id>/blocked.json` and stays idle (so a service manager that restarts it does not reconnect in a loop, which could get the number banned). `msum status` shows why; fix it with `msum link` or `msum unlink`, or run `msum daemon --retry` for a refused or replaced connection.

Several accounts can live in one installation: `msum link --account work` creates and links one (ids are lowercase letters, digits and dashes), `msum accounts` lists them, and `link`, `unlink`, `digest`, `daemon`, `status` and `doctor` take `--account <id>` (optional while there is a single account; `status` and `doctor` cover every account without it). Each account may have its own `config.json` in `accounts/<id>/` that overrides the one in the data directory: its top-level options replace the installation's, `provider` merges key by key, and the privacy lists `localOnlyPatterns` and `excludePatterns` are added to the installation's (never replaced), so an account can only make them stricter. `msum unlink --account work` deletes only that account's data. An installation from before this layout (`account/`) is moved to `accounts/default/` automatically, with no daemon running.
**Schedules.** Each account runs its digests on days of the week at a local time, kept in the database and managed with `msum schedule` (add `--account <id>` when there is more than one account):

- `msum schedule ls` lists them with their id, days, time and next run in the account's time zone.
- `msum schedule add --time 09:00 [--days daily|weekdays|weekends|mon,wed,fri|mon-fri]` adds one (every day if `--days` is left out). Day names work in English and Spanish (`lun`, `mar`, `mie`/`mié`, `jue`, `vie`, `sab`/`sáb`, `dom`).
- `msum schedule rm <id>` removes one of that account's schedules. To change a time, remove it and add the new one.

A running daemon picks the changes up within about five seconds, with no restart. These commands work while the daemon runs. Times follow the account's `timezone` and its daylight saving changes: a time that does not exist on the day of a clock change runs at the first valid time after it, and a time that happens twice runs once. A missed run (the machine was off) is made up once when the daemon starts. `msum init` writes no schedules and a new account starts with none, so no digest runs on its own until you add one (`msum link` and `msum doctor` remind you). For configurations written by earlier versions, the `schedules` option of `config.json` (cron expressions, in the installation's file or an account's) is still imported once per account, the first time the account is used: the times it can express (a fixed time on any days of the week) become schedules; the others are not imported, and `msum doctor` lists them as a warning. After that the option is ignored (`doctor` warns, and you can delete it), so a schedule you remove does not come back, and `config.json` is never rewritten. The option accepts any list of texts, so an old value never stops the configuration from loading.

4. **`msum digest --dry-run`** generates a digest now and prints it, without saving or sending anything. Without `--dry-run` the digest is queued and the running daemon delivers it. It does not open a WhatsApp connection (the daemon owns the session). Options: `--hours N`, `--from "YYYY-MM-DD HH:MM"`, `--to "YYYY-MM-DD HH:MM"`.

Other commands: `msum status` (account, last digest, pending deliveries, next runs), `msum doctor` (checks Node, permissions, configuration, provider and link) and `msum unlink`, which **deletes all the data of the account** (its messages, the digest history, pending deliveries and the WhatsApp session; the configuration stays) and asks for confirmation. Afterwards, also remove the device on the phone (WhatsApp, Settings > Linked devices).

Everything stays on your machine, in the data directory (permissions restricted to your user), except what the LLM provider you chose receives. The command-line texts are in Spanish or English (`language` in `config.json`).

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

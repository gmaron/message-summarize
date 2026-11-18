# message-summarize

[Español](README.es.md)

Reads the messages that arrive at your messaging account, summarizes them with the language model of your choice and sends you a periodic digest: which chats need a reply, what is still pending and what you can safely ignore.

The first supported platform is **WhatsApp**. The core does not depend on it, so other platforms (Telegram, Slack, email) can be added later as new adapters.

## Status

**Early development.** There is no installer and no web interface yet. A command-line version can be tried from source (see [Try it](#try-it-early-version)); expect rough edges. The approved requirements are in [docs/requirements.md](docs/requirements.md) (in Spanish) and the work is organized in the phases of the [roadmap](#roadmap).

## Try it (early version)

**Read the [warning](#important-warning) first: this uses an unofficial WhatsApp client and your number can be banned.** The program is read-only: it never marks you as online, never replies and never sends anything except the digest, which goes to your own chat ("Message yourself").

Requirements: Node 22.16 or later, and one LLM provider: [Claude Code](https://claude.com/claude-code) signed in on this machine (`claude`), a local [Ollama](https://ollama.com) server with a model already pulled, or an API key for OpenAI, Anthropic or Gemini (see [Choose an LLM provider](#choose-an-llm-provider)). There is no default provider: you choose one in the configuration.

```sh
npm install
npm run build
node dist/main/cli.js init      # or `msum init` after `npm link`; creates the data directory and config.json
```

1. **Edit `config.json`** (in the data directory that `init` prints; set `MSUM_DATA_DIR` to put it elsewhere). There is no default provider: `init` writes `"primary": null`, and **you must set `provider.primary` explicitly** (`"claude-cli"`, `"ollama"`, `"openai"`, `"anthropic"` or `"gemini"`; with all but `claude-cli` also set the model, `provider.<name>.model`; see [Choose an LLM provider](#choose-an-llm-provider)) before `digest` or the schedules work. Also check your `timezone` (`init` prints the one it wrote, the system's; **in Docker, set `TZ` or `timezone` in the config**), and your `ownerName`. The times of the digests are not in this file any more: see `msum schedule` below. A relative `promptFile` is read from the directory of the file that sets it (the data directory for `config.json`, `accounts/<id>/` for an account's own file). Invalid values are rejected with a message that names the option.
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
- **Nothing is lost to a restart.** The audios to download wait in a queue kept in the account's database (with what it takes to download each one), and the daemon works through it one at a time, oldest first: a first link with hundreds of audios just takes a while, and memory holds one audio at a time. A download cut short by a stop, a restart or a dropped connection stays queued and is resumed. A transient download failure is retried with backoff (30 seconds, then 1, 2 and 4 minutes: 5 attempts), and then the audio is recorded as failed (`download-failed`); a pending audio older than 30 days is given up (`expired`), and so is media that WhatsApp no longer has; a file that is too big or a full folder fail at once. The decryption key of each file lives only in that database while it waits, and is deleted as soon as the file is stored or the download has failed for good; it is never written to the logs.
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

## Choose an LLM provider

You choose it in `config.json` (or in an account's own file): `provider.primary`, and optionally `provider.backup`, which takes over a conversation when the primary fails (a rate limit that does not clear in time, an answer that does not fit the summary format...). Both accept `claude-cli`, `gemini-cli`, `codex-cli`, `generic-cli` (see [Use a CLI as the provider](#use-a-cli-as-the-provider)), `ollama`, `openai`, `anthropic` and `gemini`. **There is no default model for the API providers** (model names change often, and a stale default would fail later): `provider.<name>.model` is required when you use one, and the configuration is rejected without it.

| Provider | Configuration | Contacts |
|---|---|---|
| `openai` | `"provider": { "primary": "openai", "openai": { "model": "<model>" } }`. Also `baseUrl` (default `https://api.openai.com/v1`), `timeoutMs` and `structuredOutput` (`json_schema` by default; `json_object` or `prompt` for compatible servers that lack it). | `api.openai.com`, or your `baseUrl` |
| `anthropic` | `"anthropic": { "model": "claude-sonnet-5-5", "effort": "low" }` (or `claude-haiku-5-5`). Also `timeoutMs`, `maxTokens` (default 16000: current models think by default and thinking counts against it) and `effort` (`low`, `medium`, `high`, `xhigh` or `max`; unset uses the model default). `low` is a good choice for summaries: less cost and latency. | `api.anthropic.com` |
| `gemini` | `"gemini": { "model": "<model>" }`. Also `timeoutMs`. | `generativelanguage.googleapis.com` |

`openai` with a `baseUrl` works with any server that has the Chat Completions API (LM Studio, OpenRouter...); for those a key is optional. An API provider is **external even when the server is on `localhost`**: a URL cannot be verified to stay on the machine, so conversations in `localOnlyPatterns` are never sent to it. "Local only" means **your Ollama server**: conversations in `localOnlyPatterns` go to the Ollama configured in `provider.ollama.baseUrl` and to nothing else. If that address is on this machine (`localhost`, a loopback address such as `127.0.0.1`, or `host.docker.internal` for the Docker host) nothing leaves the machine. If it is another computer, the chats do go out to that server, which is yours but not this machine: `msum provider ls` and `msum doctor` say so, `msum provider use ollama` shows the disclosure and asks for consent. Use a loopback URL if you need it on this machine.

**API keys never go in `config.json`** (a key written there is rejected, with a message that points here). Save it with:

```sh
msum secret set openai        # or anthropic, gemini; add --account <id> for one account only
```

The key is read from the input (hidden when you type it, or piped: `msum secret set openai < key.txt`), never from an argument, which would show in `ps` and in your shell history. It is saved in `secrets.json` in the data directory (`accounts/<id>/secrets.json` with `--account`), with permissions 600, and it is never printed or logged. `msum secret ls` shows which providers have a key and where it comes from (never the key) and `msum secret rm <provider>` removes one. A key is looked up in this order: **environment variable** (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`), then `accounts/<id>/secrets.json`, then `secrets.json`. There are two OpenAI keys, so the real one never goes to another server: **`openai`** (`msum secret set openai`, or `OPENAI_API_KEY`) is used only when the origin of `baseUrl` is exactly `https://api.openai.com`, and **`openai-compatible`** (`msum secret set openai-compatible`, or `MSUM_OPENAI_API_KEY`) is used for any other `baseUrl`. The same rule holds for the account and installation files and for the environment: a compatible server never receives the `openai` entry, and if it needs no key none is sent. `msum secret ls` shows all the keys, and `msum doctor` says which one your configuration will use, checks that the model is set, that a key exists and that `secrets.json` (the installation's and each account's) is readable only by you, without contacting anything.

If a provider answers "too many requests", the program waits for the time it asks for (`Retry-After`, or the retry delay Gemini puts in the error) and tries again; an overloaded server (503, 529) or a network error is retried with a growing wait. Each conversation has its own budget, by default 3 retries and 120 seconds of waiting in total (`provider.retry.maxRetries` and `provider.retry.maxWaitMs`), and the whole call, attempts and waits together, may not pass 300 seconds (`provider.retry.maxTotalMs`). A provider that redirects, or answers with more than 2 MB, fails the call: redirects are never followed, because that would resend your chat and key to a host you did not choose. If it is not enough, that conversation goes to the backup provider if there is one, and otherwise the digest comes out with the conversations that could be summarized and says which were left out.

**Privacy: the text of your chats leaves your machine** for the provider you choose, except for `localOnlyPatterns` conversations (summarized by Ollama). What each one does with it, from its own pages (check them, terms change):

- **OpenAI:** by default API data is not used to train its models, and abuse-monitoring logs are kept for up to 30 days. [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data).
- **Anthropic:** by default it does not train on inputs or outputs of its commercial offerings, the API included. [Is my data used for model training?](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training)
- **Gemini:** with a free (unpaid) key, Google may use what you send to improve its products, and human reviewers may read it; with billing enabled that is not the default. **Do not use a free key for chats you would not want read**, and mark sensitive chats as local only. [Gemini API data logging and sharing](https://aistudio.google.com/docs/logs-policy).
- **Claude Code (`claude-cli`):** what Anthropic does depends on your account type: on a consumer plan (Free, Pro, Max) your data may be used to improve its models if that setting is on, and kept for 30 days or 5 years accordingly; under commercial terms (Team, Enterprise, API) it is not used for training. [Claude Code data usage](https://code.claude.com/docs/en/data-usage).

## Use a CLI as the provider

If you already pay for a plan, or want no API key, a provider can be a program on your machine that uses the session you already signed in with. There are three modes: `claude-cli`, `gemini-cli` and `codex-cli` (presets) and `generic-cli` (any command). All of them are **external** like the APIs: conversations in `localOnlyPatterns` never reach them.

**The rule (RF-49).** The chats are written by other people, and a CLI is an agent that can read files and run commands: text in a chat could try to make it do so (prompt injection). So a CLI preset is only used when the program can be **verified** to run without tools. Before the first call, and in `msum doctor`, the program runs `<cli> --help` and `<cli> --version` (never a model call, in an empty temporary directory, with the environment below) and every flag the hardening relies on must be listed. If one is missing, the provider is unavailable with the reason "this version of X cannot be run without tools", and the conversation goes to the backup provider. The result is remembered per program path and modification time, so an upgrade is checked again.

| Preset | Status | Flags and why |
|---|---|---|
| `claude-cli` | enabled | `claude -p --model <m> --system-prompt <s> --json-schema <schema> --output-format json --tools '' --strict-mcp-config --no-session-persistence --safe-mode --disable-slash-commands`. `-p` is the headless mode; `--json-schema` forces the summary format natively; `--tools ''` turns every tool off; `--strict-mcp-config` loads no MCP server; `--no-session-persistence` saves no session; `--safe-mode` ignores your customizations (CLAUDE.md, skills, plugins, hooks, MCP), so no hook receives the chat; `--disable-slash-commands` turns off commands and skills. The chat goes through stdin, never as an argument. |
| `gemini-cli` | **disabled** | Gemini CLI (`-p`, `-o json`) has no documented flag that turns its tools off: `--allowed-tools` is deprecated, `--allowed-mcp-server-names` and `--extensions` only select, `--approval-mode plan` is read-only but still has tools (file reads, web fetch), and sessions cannot be turned off. A deny-all policy exists, but its flag (`--admin-policy`) is documented without saying whether it takes a file or a directory, and it is ignored when policy files exist in the system location. |
| `codex-cli` | **disabled** | `codex exec --sandbox read-only --ephemeral --ignore-user-config --output-schema <file>` restricts what commands may write, saves no session and forces a schema, but the shell tool stays available: the documentation says the sandbox limits "model-generated shell commands", not that it removes them, and no documented switch turns off the shell, MCP and web search together. |

A disabled preset fails every call at once with that reason and `msum doctor` says so; nothing is run. They will be enabled when a documented way to turn the tools off can be verified in `--help`. Until then the generic CLI can run them, with the risk below. Sources: the [Claude Code](https://code.claude.com/docs/en/network-config), [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md) and [Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli) documentation.

**What the CLI receives.** Only these variables, when set, and never one of your API keys: `PATH` (to find the program and its runtime), `HOME`, `USER` and `LOGNAME` (to find your existing login), `CLAUDE_CONFIG_DIR` (a login kept elsewhere; Claude only), `LANG` and `TZ`. Proxy and certificate variables are not passed: set them where the CLI itself reads them. It runs with no shell, in a fresh empty temporary directory that is removed afterwards, with a time limit that kills the whole process group (grandchildren included), and at most 2 MB of output.

**Signing in.** The CLI uses the login you already made for it. Inside a Docker or sandbox container the login must be made inside it, once, and kept in a volume: for Claude, run `claude` in the container (for example `docker exec -it <container> claude`, or `sbx claude` when you use `sbx`), sign in, and keep its configuration directory (`~/.claude`, or the one in `CLAUDE_CONFIG_DIR`) in a volume so the daemon sees it.

**The answer format (RF-48).** `claude-cli` forces the schema with `--json-schema`; if the answer is still unusable it is asked once more to correct it. A CLI without a native schema flag (the generic one) gets the schema in the prompt, the answer is validated, and if it is invalid it is asked ONCE more with a message that says what was wrong; if that fails too, the conversation goes to the backup provider (RF-42).

**The generic CLI** (`generic-cli`) runs any command that takes the prompt and prints text with the answer:

```json
"provider": {
  "primary": "generic-cli",
  "genericCli": { "command": ["my-llm", "--json", "{{prompt}}"], "timeoutMs": 180000, "acknowledgeRisk": true }
}
```

`command` is an argument list, with no shell and no interpolation inside an element. **By default the prompt goes through stdin, which is private.** An element that is exactly `{{prompt}}` receives the whole prompt instead: use it only for a tool that cannot read stdin, because **arguments are visible to other users of the machine** (`ps`) and a long chat can exceed the size limit of arguments; `msum doctor` warns when the command uses it. `{{prompt}}` is never the program and never part of a longer element. There is no default command. **It cannot be hardened:** the command may run tools on text written by third parties, so it is refused unless you set `acknowledgeRisk` to `true`; `msum doctor`, `msum digest` and the daemon print this warning every time it is about to be used. Prefer a provider that runs without tools.

## Choose and test your provider

Four commands, in this order (add `--account <id>` when there is more than one account):

1. **`msum provider ls`** lists every provider with what it costs (an API charges per use, a CLI uses your plan, Ollama is free), whether your chats leave the machine and to which hosts, a link to its data policy, whether it is configured here (primary or backup), whether its key is present (where it comes from, never the key) and whether it is usable now (CLIs are verified, disabled presets say so). It makes no network call.
2. **`msum provider use <name> [--model <m>] [--backup] [--yes]`** chooses the provider and its model. It writes `provider.primary` (or `provider.backup`) in the `config.json` of the account, which it creates if needed, and **says which file it wrote**. It never writes the installation's `config.json`, even with a single account: the consent below is per account, so the provider it covers must be too (an account linked later would otherwise inherit an external provider it never saw disclosed). It keeps every other key, writes atomically and validates the result first: an invalid result writes nothing. **Before activating a provider that sends your chats out it tells you what it receives** (the text of the conversations that are not local only, the names of the chats and contacts as they appear in them, the phone numbers of the contacts you have not saved, the transcripts of voice notes, and your name as the owner), to which hosts and where its policy is, and asks you to confirm; `--yes` skips the question, not the information. **Your answer is recorded** (RNF-02) for that account, with the date and the hosts that were shown: a different host, for example another `--base-url` or another Ollama address, needs a new consent, and for `generic-cli` the consent is keyed by the command that was shown, so changing the command needs a new one. `msum provider ls` shows the date (or "none recorded"), and `msum doctor` warns, without blocking anything, when a chosen provider that sends your chats out has no recorded consent. The consent is a record and a reminder, not a lock: editing `config.json` by hand is the expert path and keeps working (an installation configured that way, for example with `claude-cli`, runs as before); the guided path is the one that records it, and `doctor` makes the gap visible. Deleting the account (`msum unlink`) deletes its consents. It refuses `gemini-cli` and `codex-cli` (disabled), and for `generic-cli` it explains `acknowledgeRisk`, which you set yourself and it never sets. `openai-compatible` needs `--base-url <url>`.
3. **`msum secret set <name>`** saves the API key when the provider needs one (see [Choose an LLM provider](#choose-an-llm-provider)). `provider use` never touches keys; it reminds you when one is missing.
4. **`msum provider test [--backup] [--kind <name>]`** is the "test connection": ONE real call to the provider, with a **made-up conversation** built into the program (invented names), never your messages. Before the call it says where it goes. It prints the latency and a summary of the validated answer, or the error (with any key removed) and a hint: missing key, a key that was refused, an unknown model, a rate limit, a timeout, a disabled preset, a CLI that cannot be verified, or a server that cannot be reached. Exit code 0 when it works, 1 when it does not. `msum doctor` never calls a provider; it points you here.

The usual setups:

- **Claude Code with your plan (no key):** `msum provider use claude-cli`, sign in once with `claude` (inside a container, see [Use a CLI as the provider](#use-a-cli-as-the-provider)), then `msum provider test`.
- **Anthropic API:** `msum provider use anthropic --model claude-sonnet-5-5`, `msum secret set anthropic`, `msum provider test`.
- **OpenAI:** `msum provider use openai --model <model>`, `msum secret set openai`, `msum provider test`. For LM Studio, OpenRouter and similar: `msum provider use openai-compatible --base-url <url> --model <model>`, and `msum secret set openai-compatible` if it needs a key.
- **Gemini free tier:** `msum provider use gemini --model <model>`, `msum secret set gemini`, `msum provider test`. A free key may be used by Google to improve its products: see the privacy note above, and mark sensitive chats as local only.
- **Ollama, all on your machine:** `ollama pull <model>`, `msum provider use ollama --model <model>`, `msum provider test`. With Ollama on this machine nothing leaves it, so it asks nothing; with `provider.ollama.baseUrl` on another computer it shows the disclosure and asks, like any provider that receives your chats.

Add a second one as the backup with `--backup`, for example `msum provider use ollama --backup --model <model>`.

## Choosing a local model (Ollama)

A small model of 3 to 8 billion parameters can summarize on your own machine. Which one is a question of RAM and of how well it does the job, so the program has a table of candidates and a way to measure them (RF-45).

**You choose the model; the program does not pick one for you.** It lists the candidates that fit your RAM, shows what was measured for each, and leaves the decision to you. Four candidates have been evaluated so far (81 conversations, 2026-11-18, on a local Ollama); the other six have not:

| Model | Valid JSON | Agreement, clear cases | Doubtful cases | Mean per summary | RF-45 |
|---|---|---|---|---|---|
| `qwen3.5:4b` | 100% | 92.1% | 66.7% | 3.6 s | passes |
| `qwen3:8b` | 100% | 90.5% | 41.7% | 4.3 s | passes |
| `qwen2.5:3b` | 100% | 87.3% | 58.3% | 2.1 s | fails |
| `qwen3:4b` | 100% | 63.5% | 41.7% | 3.1 s | fails |

So far `qwen3.5:4b` is the best evaluated option: it passed with the highest agreement while being smaller and faster than `qwen3:8b`. It is information, not a default: nothing is configured until you run the commands below. The numbers come from one run each on one machine, with the evaluation set described below; a model not in the table has not been measured, which is not the same as being bad.

- **`msum ollama recommend [--all]`** reads the RAM of this machine and lists the candidates that fit, in this order: the ones that passed the evaluation (best agreement first), then those not evaluated, then those that failed. For each it shows the download size, the minimum RAM and its evaluation, with the numbers. Candidates that need more RAM than you have are hidden (it says how many); `--all` shows them marked. It makes no network call, picks nothing and writes nothing: it ends with the commands to run once you have chosen (`msum ollama pull <tag>`, then `msum provider use ollama --model <tag>`, or `provider.ollama.model` in `config.json`). The table is in `src/infrastructure/llm/ollama-candidates.ts`: tags, parameters and sizes come from the pages of the Ollama library (read on 2026-11-17, listed in that file). The **minimum RAM is an estimate** (download size times 1.25 plus 3 GB), not a number Ollama publishes. The candidates are `qwen3.5:4b`, `qwen3:4b`, `qwen3:8b`, `qwen2.5:3b`, `qwen2.5:7b`, `gemma3:4b`, `gemma4:e4b`, `llama3.2:3b`, `llama3.1:8b` and `phi4-mini:3.8b`; newer tags appear in the library all the time, so check it and edit the table.
- **`msum ollama pull <tag> [--account <id>]`** asks the Ollama configured in `provider.ollama.baseUrl` to download the model (its `/api/pull`), with a progress line and a check that Ollama finishes with `success`. It sends only the tag, never chat text, and it **only works against an Ollama on this machine** unless you add `--allow-remote` (a model is downloaded to the server that receives the request, so pulling to another computer should be a decision). Errors from the server are shown with key-shaped text removed. Then choose it with `msum provider use ollama --model <tag>` and try it with `msum provider test`.
- **`msum doctor`** also asks your Ollama for its list of models (`/api/tags`, 3 seconds, no chat text) when Ollama is the primary, the backup or serves your "local only" chats, and fails if the configured model is not installed, with the `msum ollama pull` command to fix it. `msum doctor --skip-model-check` leaves that call out (the check that Ollama answers at all is separate and stays).

### Evaluating a model

`npm run eval:ollama -- --models qwen3.5:4b,gemma3:4b [--base-url URL] [--runs N] [--allow-remote]`

The evaluation set is in `test/eval/ollama/`: **81 conversations taken from the golden files** (all made up), each with the exact transcript the summarizer receives (`transcripts.json`, produced by `test/eval/extract-cases.mjs`) and a **hand-written label** of whether the owner has to reply, with a one-line reason (`labels.json`, `doubtful` marks the ones a reader could argue). The answers of the previous tool were used only as a cross-check, never as the truth. For every model and case the script calls the real `OllamaSummarizer` with the production prompt and schema and records whether the JSON was valid, whether "needs reply" matches the label (an invalid answer counts as a mismatch), the latency and the error. It prints a table and writes `test/eval/ollama/results/<date>-<model>.json` (ids and numbers, no chat text).

The labelling rule is written in `test/eval/ollama/README.md`. **Valid JSON is judged on every case; agreement is judged on the clear cases only** (not marked `doubtful`, and not the six filler cases marked `jsonOnly`, which count for valid JSON and not for agreement). The agreement on the doubtful cases and the overall one are printed and stored as separate columns, for information. Committed results files in `test/eval/ollama/results/` are not ignored: they are what promotes a candidate to evaluated.

**A model passes RF-45 with 100% valid JSON and at least 90% agreement on "needs reply" (clear cases).** The script exits with 1 if a model does not pass. It refuses a `--base-url` that is not on this machine unless you pass `--allow-remote`. It needs your own Ollama running with the models already pulled; it never starts one.

To record an evaluation, passing or failing, set `evaluated: true` and `result: { date, validJsonRate, needsReplyAgreement, meanLatencyMs, passed }` on its entry in `ollama-candidates.ts` (the script prints the line) and commit it together with the results file; a test fails if a committed results file and the table disagree. Models without a results file stay "not evaluated".

## What the program connects to

Nothing is sent anywhere except:

- **WhatsApp**, through the connection of your own account (including the download of the audios you receive, when transcription is on).
- **The LLM provider you chose**, and nothing else: with Ollama, the URL you configured; with an API provider, exactly one of `api.openai.com` (or your `provider.openai.baseUrl`), `api.anthropic.com` or `generativelanguage.googleapis.com`. **The text of the conversations that are not local only is sent there**, together with your summary prompt. Keys travel only in the request headers.
- **With `claude-cli`, whatever Claude Code itself contacts**, which is its vendor's own hosts, per [its network documentation](https://code.claude.com/docs/en/network-config): `api.anthropic.com` (the model requests, which carry the text of the conversations that are not local only, and its own operational telemetry), `claude.ai`, `claude.com`, `platform.claude.com` and `sso.claude.com` (sign-in), and `http-intake.logs.us5.datadoghq.com` and `browser-intake-us5-datadoghq.com` (optional telemetry of the CLI, which its settings can turn off: `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`). That traffic is the CLI's, not this program's, and the program does not pass those variables to it: set them in the settings file of Claude Code. `gemini-cli` and `codex-cli` are disabled and contact nothing. A `generic-cli` command contacts whatever it does.
- **Your own Ollama server, when you run `msum ollama pull <tag>` or `msum doctor`:** the tag to download, or a request for its list of models, to the URL in `provider.ollama.baseUrl` and nowhere else; no chat text. The download itself is made by Ollama, not by this program.
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

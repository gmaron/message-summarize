# The daemon, accounts and schedules

This guide covers the initial configuration (`config.json`), linking accounts, what the daemon does and how schedules work. Back to the [README](../../README.md).

## Initial configuration (`config.json`)

From source, the first command creates the data directory and the file:

```sh
npm install
npm run build
node dist/main/cli.js init      # or `msum init` after `npm link`; creates the data directory and config.json
```

Edit `config.json` in the data directory that `init` shows (set `MSUM_DATA_DIR` to put it elsewhere).

- **Provider.** There is no default provider: `init` writes `"primary": null`. You must set `provider.primary` explicitly (`"claude-cli"`, `"ollama"`, `"openai"`, `"anthropic"` or `"gemini"`) before `digest` or the schedules work. With all of them except `claude-cli`, also set the model: `provider.<name>.model`. See the [providers guide](providers.md).
- **Time zone.** Check `timezone`: `init` prints the one it wrote, the system's. **In Docker, set `TZ` or `timezone` in the configuration.**
- **Name.** Check `ownerName`.
- **Schedules.** The digest times are no longer in this file: see [Schedules](#schedules).
- **`promptFile`.** A relative `promptFile` is read from the directory of the file that defines it: the data directory for `config.json`, `accounts/<id>/` for an account's own file.
- **Errors.** Invalid values are rejected with a message that names the option.

The command-line texts are in Spanish or English (`language` in `config.json`). Everything stays on your machine, in the data directory (readable only by your user), except what the LLM provider you chose receives.

## Linking an account

`msum link` shows a QR code in the terminal (it also stays as `qr.png` while valid). Scan it from WhatsApp, Settings > Linked devices. It waits for the initial history and finishes. The web page does the same: see [the web page and accounts](web-and-accounts.md).

## The daemon

`msum daemon` connects every account, captures messages, runs the schedules and delivers each digest to that account's own chat. Leave it running: Ctrl+C stops it in an orderly way.

- It runs **one daemon per installation**, and it runs **all accounts**.
- Each account is isolated (its own connection, schedules, recovery of missed runs and delivery): a blocked or failing account does not stop the others.
- A failure inside an account restarts only that account, with a growing wait.
- `msum daemon --account <id>` runs only that account: useful for debugging.
- An account with an invalid configuration, or with schedules and no provider, is reported and stays inactive while the others run. The daemon refuses to start only if `--account` names such an account, or if all of them are like that.
- An account with nothing linked stays inactive: no connection is opened for it.

### Blocks

If WhatsApp closes a session, rejects the connection (403) or replaces it, or the session belongs to another number, the daemon stops connecting **that** account, writes `accounts/<id>/blocked.json` and leaves it inactive. That way a service manager that restarts the daemon does not reconnect in a loop, which could get the number banned. `msum status` shows the reason, and each account's connection state while the daemon runs.

| Situation | How to fix it |
|---|---|
| Connection rejected or replaced | `msum retry --account <id>`. A running daemon picks the account up again within seconds. |
| The session is no good | Link again: `msum unlink --account <id>` and then `msum link --account <id>`. |
| Start the daemon clearing blocks | `msum daemon --retry` deletes, before starting, exactly the blocks that `msum retry` deletes (a dead session stays blocked). |

A block is never lifted on its own: a missing `blocked.json` counts as "deleted" only if the daemon knows it was on disk.

If an account's connection keeps failing (5 failures in a row, with growing waits; a unit that stays connected for 10 minutes starts the count over), the daemon stops trying and blocks it (`socketFailed`) instead of looping. `msum retry` brings it back.

### The daemon keeps watching the installation

- An account you link later starts by itself, one that is deleted stops, and a deleted block is retried.
- You can run `msum link --account <new-id>` while the daemon runs: the account is locked for the daemon while it is being linked (`accounts/<id>/link.lock`), and the daemon starts it only when linking ends.
- `msum link` and `msum unlink` reject an account the daemon is using (linked and not blocked), because it owns its session: stop the daemon first. Accounts it does not use (unlinked, or blocked) can be linked or unlinked while the daemon runs.

### Registering the daemon as a service

`msum service install|uninstall|status` registers only the daemon so that it starts with your session and comes back after a crash: launchd on macOS, `systemd --user` on Linux, a `Run` entry for your user on Windows. It needs no administrator permissions, and the schedules stay inside the daemon.

## Several accounts

An installation can have several accounts: `msum link --account work` creates and links one (ids are lowercase letters, digits and hyphens), and `msum accounts` lists them.

- `link`, `unlink`, `digest`, `daemon`, `status` and `doctor` accept `--account <id>`. It is optional while there is a single account; `status` and `doctor` go through all accounts without it.
- Each account can have its own `config.json` in `accounts/<id>/` that overrides the one in the data directory:
  - its top-level options replace those of the installation;
  - `provider` is merged key by key;
  - the privacy lists `localOnlyPatterns` and `excludePatterns` are **added** to those of the installation (they never replace them), so an account can only make them stricter.
- A pattern is a piece of `<id> <name>`, case-insensitive ("ana" also matches "Mariana"), except `id:<conversation id>`, which matches exactly that id. This is what the web page writes when you mark a chat, because a plain id such as `5491112345678@s.whatsapp.net` is also contained in `15491112345678@s.whatsapp.net`.
- `msum unlink --account work` deletes only that account's data.
- An installation that predates this structure (`account/`) moves itself to `accounts/default/`, with no daemon running.

## Schedules

Each account runs its digests on days of the week at a local time, stored in the database and managed with `msum schedule` (add `--account <id>` when there is more than one account).

| Command | What it does |
|---|---|
| `msum schedule ls` | Lists them with their id, days, time and next run in the account's time zone. |
| `msum schedule add --time 09:00 [--days ...]` | Adds one (every day if you omit `--days`). `--days` accepts `daily`, `weekdays`, `weekends`, `mon,wed,fri` or `mon-fri`. Day names work in English and Spanish (`lun`, `mar`, `mie`/`mié`, `jue`, `vie`, `sab`/`sáb`, `dom`). |
| `msum schedule rm <id>` | Deletes one of that account's schedules. To change a time, delete it and add the new one. |

Rules:

- A running daemon picks up changes in about five seconds, without restarting. These commands work while the daemon runs.
- Times follow the account's `timezone` and its daylight saving changes: a time that does not exist on the change day runs at the first valid time after it, and a time that happens twice runs only once.
- A missed run (the machine was off) is recovered once when the daemon starts.
- `msum init` writes no schedules and a new account starts with none, so no digest runs by itself until you add one (`msum link` and `msum doctor` remind you). The web wizard creates 09:00 and 18:00 every day.

### Configurations written by earlier versions

The `schedules` option of `config.json` (cron expressions, in the installation file or an account's) is still imported once per account, the first time the account is used.

- The times that can be expressed (a fixed time on any day of the week) become schedules.
- The others are not imported and `msum doctor` lists them as a warning.
- After that the option is ignored (`doctor` warns, and you can delete it), so a schedule you delete does not come back, and `config.json` is never rewritten.
- The option accepts any list of strings, so an old value never prevents the configuration from loading.

## Generating a digest by hand

`msum digest --dry-run` generates a digest now and shows it, without saving or sending anything. Without `--dry-run` the digest is queued and delivered by the running daemon. It does not open a WhatsApp connection (the session belongs to the daemon). Options: `--hours N`, `--from "YYYY-MM-DD HH:MM"`, `--to "YYYY-MM-DD HH:MM"`.

## Other commands

| Command | What it does |
|---|---|
| `msum status` | Account, last digest, pending deliveries, next runs. |
| `msum doctor` | Checks Node, permissions, configuration, provider, linking and, if enabled, transcription. |
| `msum whisper models\|download <name>` | See [Transcribing voice notes](transcription.md). |
| `msum service install\|uninstall\|status` | See [above](#registering-the-daemon-as-a-service). |
| `msum unlink` | **Deletes all of the account's data**: its messages, the audio it downloaded, the digest history, the pending deliveries and the WhatsApp session. The configuration stays. It asks for confirmation. Afterwards, also remove the device on your phone (WhatsApp, Settings > Linked devices). |

---

Back to the [README](../../README.md) · [Guides index](README.md)

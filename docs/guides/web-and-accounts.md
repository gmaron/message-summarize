# The web page, the wizard and accounts

While it runs, the daemon serves a local page. This guide explains what you can do from it. Back to the [README](../../README.md).

## Address, token and network

- By default it is at `http://127.0.0.1:8787`. It is set with the `web` option of the installation's `config.json`: `port`, `host`, `enabled`.
- `msum open` opens it already signed in. The address carries an access token, generated once in the data directory (`web-token`): do not share it.
- It listens only on this machine. Another `host` (for example `0.0.0.0` inside Docker, publishing the port only on `127.0.0.1`) is an explicit choice.
- Behind a reverse proxy that forwards the name it was reached by (for example `tailscale serve`), the web answers 403 to that name, because it only accepts IPs and loopback names. `web.allowedHosts` in the installation's `config.json` (empty by default) lists the names it does accept, with no scheme or port: `"allowedHosts": ["my-host", "my-host.my-net.ts.net"]`. A listed name is accepted without a port and its `Origin` over `https` too; the token is still required and any other name still gets 403.

## What you can do

The sections of each account are Summary, Conversations, Schedules, History and Settings.

- **Accounts.** Add an account and link it by scanning the QR, follow the history sync and see each account's state.
- **Unblock.** Link again or retry. After a rejected or replaced connection, the page makes you wait 30 minutes.
- **Schedules.** Edit them, use "summarize now" and see a preview that sends nothing and does not move the pointer.
- **Conversations.** List and search an account's conversations and mark each one as excluded or local only (see [below](#excluding-and-local-only)).
- **Prompt.** Edit each account's prompt and go back to the original, which saves your text in `prompt.previous.md`. The only variable is `{{name}}`; the response format is fixed and added automatically.
- **Logs.** The "Logs" button shows the daemon's latest log lines, filterable by level and account; they never include messages, names or secrets.
  - The daemon also writes them to `logs/daemon.log` inside the data directory (it rotates to `daemon.log.1`).
  - Both files together stay below `logs.maxBytes` (only in the installation's `config.json`, 50 MB by default, minimum 1 MB).
- **Settings.** Settings, conversations, the prompt, history, logs and the initial setup are all in the web already.

The web does not configure transcription yet: it is turned on in `config.json` (see the [transcription guide](transcription.md)). Codex is disabled (RF-49) until a way to turn its tools off can be verified; any other command is still chosen with `msum provider use generic-cli`.

## Excluding and "local only"

- **Excluding a chat deletes the messages and the chat row stored so far.** It does not remove the summaries already inside past digests (the digest history is kept) nor the parts already waiting in the delivery queue. Removing the exclusion recovers nothing.
- A mark covers the ids of that person that WhatsApp has told this computer about (a number and an internal id). If the same person shows up as a second chat, mark that one too.
- **"Local only"** needs an Ollama model in the configuration (see [local model](local-model-ollama.md)).

## The first-run wizard

The first time the page is opened on an installation with no linked account, a three-step wizard starts.

| Step | What you do |
|---|---|
| **You** | Your name and the account name. The page starts in Spanish; on a new installation it follows the browser language (Spanish or English, whichever it asks for first). There is a Español \| English selector in this first step, and the language you see when you save the step is the one that gets written. The time zone is the browser's, without any network lookup. Both can be changed later in Settings. |
| **Summary** | The provider, with its test and its acceptance. |
| **Link** | The QR and the history sync. |

- When it finishes it creates the default schedules, 09:00 and 18:00 every day, which you edit in the Schedules tab. The time zone in use is shown next to the schedules (a lone daemon, as in Docker, would use UTC unless you set `TZ`).
- You can close it halfway and resume (its state is saved in `app.db`), or skip it. An installation that already has a linked account (made with the command line or with `msum import`) never sees it.
- It is also the only place where the web writes the installation's `config.json`, and only its `language` and `timezone`, and only on a freshly created installation (no accounts and with the language `msum init` writes).

### Choosing the provider in the wizard

When you choose the provider, the wizard shows:

- how much each one costs;
- whether the data leaves your computer, to whom, and what the provider does with it;
- a **Test connection** button, which makes a real call with a short made-up chat and only runs when you click.

In the wizard, "Test connection" can test a key you typed without saving it (Settings does not offer that test).

## Accepting an external provider

A provider that sends the text of your chats off this machine needs an explicit acceptance: you must tick the box, and it is recorded (account, provider, text version and time) in `app.db`. The external ones are:

- Claude Code, which sends it to Anthropic under your Claude account;
- OpenAI, Anthropic and Gemini through their APIs;
- any server compatible with the OpenAI API, even one on your own computer.

More details:

- Settings asks for the same acceptance the first time you choose such a provider for an account.
- Ollama on your own machine needs none. But an Ollama server whose address is not this machine's (not `localhost`, not `127.0.0.0/8`, not `::1`) also counts as an external recipient: the page names the host, warns that "local only" conversations go there too and asks for the same acceptance.
- A configuration written by hand or with the command line is not blocked by this: the acceptance refers to the choice made in the web.
- Each provider shows its own notice before use (OpenAI, Anthropic, Google or the server's host), says that "local only" chats never go to an external provider, and for Gemini adds the free-plan warning. Changing the address of a compatible server asks for the acceptance again.

## API keys in the web

OpenAI, Anthropic and Gemini are chosen in the wizard and in Settings with their model and API key. For OpenAI you can also enter the address of any compatible server (LM Studio, OpenRouter...), which is considered external even if it is `localhost` and uses its own key (`openai-compatible`), separate from OpenAI's.

- The page shows whether a key exists and where it comes from (environment variable, the account's or the installation's key file), but never the key.
- It is stored in the installation's `secrets.json` (mode 0600) and is never written to `config.json` or `app.db`.
- The field is emptied as soon as the key is saved or tested.

More in the [providers guide](providers.md).

## Several accounts

See [The daemon, accounts and schedules](daemon-and-schedules.md#several-accounts).

---

Back to the [README](../../README.md) · [Guides index](README.md)

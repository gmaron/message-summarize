# Choosing and testing the LLM provider

This guide explains how to choose the provider that writes the digests, how to store its key, how to test it and what each one does with your data. Back to the [README](../../README.md).

## The providers

You choose in `config.json` (or in an account's own file): `provider.primary` and, optionally, `provider.backup`, which takes over a conversation when the primary fails (a usage limit that does not lift in time, a response that does not meet the digest format...).

Both accept `claude-cli`, `gemini-cli`, `codex-cli`, `generic-cli` (see [Using a CLI as a provider](cli-provider.md)), `ollama`, `openai`, `anthropic` and `gemini`.

**API providers have no default model** (model names change often, and an outdated default would fail later): `provider.<name>.model` is required when you use one, and the configuration is rejected without it.

| Provider | Configuration | Connects to |
|---|---|---|
| `openai` | `"provider": { "primary": "openai", "openai": { "model": "<model>" } }`. Also `baseUrl` (default `https://api.openai.com/v1`), `timeoutMs` and `structuredOutput` (`json_schema` by default; `json_object` or `prompt` for compatible servers that lack it). | `api.openai.com`, or your `baseUrl` |
| `anthropic` | `"anthropic": { "model": "claude-sonnet-5-5", "effort": "low" }` (or `claude-haiku-5-5`). Also `timeoutMs`, `maxTokens` (16000 by default: current models think by default and that counts against the limit) and `effort` (`low`, `medium`, `high`, `xhigh` or `max`; unset uses the model's own value). `low` suits digests: less cost and latency. | `api.anthropic.com` |
| `gemini` | `"gemini": { "model": "<model>" }`. Also `timeoutMs`. | `generativelanguage.googleapis.com` |

### Compatible servers and "local only"

`openai` with a `baseUrl` works for any server with the Chat Completions API (LM Studio, OpenRouter...); for those the key is optional.

An API provider is **external even if the server is on `localhost`**: it cannot be verified that a URL stays on the machine, so conversations matching `localOnlyPatterns` are never sent to it.

"Local only" means **your Ollama server**: conversations matching `localOnlyPatterns` go to the Ollama configured in `provider.ollama.baseUrl` and nowhere else.

- If that address is this machine's (`localhost`, a loopback address such as `127.0.0.1`, or `host.docker.internal` for the Docker host) nothing leaves the machine.
- If it is another computer, the chats do leave for that server, which is yours but is not this machine: `msum provider ls` and `msum doctor` say so, and `msum provider use ollama` shows the information and asks for consent. Use a loopback URL if you need it on this machine.

## Choosing and testing, step by step

Four commands, in this order (add `--account <id>` when there is more than one account).

### 1. `msum provider ls`

Lists each provider with:

- how much it costs (an API charges per use, a CLI uses your plan, Ollama is free);
- whether your chats leave the machine and to which servers, and a link to its data policy;
- whether it is configured here (primary or backup);
- whether its key is present (where it comes from, never the key);
- whether it is usable now (CLIs are verified, disabled presets say so).

It makes no network call.

### 2. `msum provider use <name> [--model <m>] [--backup] [--yes]`

Chooses the provider and its model.

- It writes `provider.primary` (or `provider.backup`) in the account's `config.json`, which it creates if needed, and **says which file it wrote**.
- It never writes the installation's `config.json`, not even with a single account: consent is per account, so the provider it covers has to be too (an account linked later would otherwise inherit an external provider it never saw explained).
- It keeps all the other keys, writes atomically and validates the result first: an invalid result writes nothing.
- It rejects `gemini-cli` and `codex-cli` (disabled), and for `generic-cli` it explains `acknowledgeRisk`, which you set and it never does. `openai-compatible` needs `--base-url <url>`.

**Before enabling a provider that sends your chats out, it tells you what it receives:**

- the text of the conversations that are not local only;
- the names of chats and contacts as they appear in them;
- the phone numbers of contacts you have not saved;
- the transcripts of voice notes;
- your name as owner.

It also says which servers it goes to, where its policy is, and asks you to confirm. `--yes` skips the question, not the information.

**Your answer is recorded** (RNF-02) for that account, with the date and the servers that were shown.

- A different server (for example another `--base-url` or another Ollama address) needs new consent. For `generic-cli` the consent is tied to the command that was shown, so changing the command asks again.
- `msum provider ls` shows the date (or "none recorded"), and `msum doctor` warns, without blocking anything, when a chosen provider that sends your chats out has no recorded consent.
- Consent is a record and a reminder, not a lock: editing `config.json` by hand is the expert path and keeps working (an installation configured that way, for example with `claude-cli`, works as before). The guided path is the one that records it, and `doctor` makes the gap visible.
- Deleting the account (`msum unlink`) deletes its consents.

### 3. `msum secret set <name>`

Stores the API key when the provider needs one (see [API keys](#api-keys)). `provider use` never touches keys; it warns you when one is missing.

### 4. `msum provider test [--backup] [--kind <name>]`

This is "test connection": ONE real call to the provider, with a **made-up conversation** shipped in the program (invented names), never your messages. Before the call it says where it goes.

- It shows the latency and a summary of the validated response, or the error (without any key) and a hint: missing key, key rejected, model does not exist, a usage limit, a timeout, a disabled preset, a CLI that cannot be verified, or a server that cannot be reached.
- Exit code 0 if it works, 1 if not.
- `msum doctor` never calls a provider; it sends you here.

## Usual setups

| I want to use | Commands |
|---|---|
| **Claude Code with your plan (no key)** | `msum provider use claude-cli`, sign in once with `claude` (inside a container, see [Using a CLI as a provider](cli-provider.md#signing-in)), then `msum provider test`. |
| **Anthropic API** | `msum provider use anthropic --model claude-sonnet-5-5`, `msum secret set anthropic`, `msum provider test`. |
| **OpenAI** | `msum provider use openai --model <model>`, `msum secret set openai`, `msum provider test`. For LM Studio, OpenRouter and similar: `msum provider use openai-compatible --base-url <url> --model <model>`, and `msum secret set openai-compatible` if it needs a key. |
| **Gemini, free plan** | `msum provider use gemini --model <model>`, `msum secret set gemini`, `msum provider test`. Google may use a free key to improve its products (see [Privacy](#privacy-what-each-provider-does-with-your-data)): mark sensitive chats as local only. |
| **Ollama, everything on your machine** | `ollama pull <model>`, `msum provider use ollama --model <model>`, `msum provider test`. With Ollama on this machine nothing leaves it, so it asks nothing; with `provider.ollama.baseUrl` on another computer it shows the information and asks, like any provider that receives your chats. See [Choosing a local model](local-model-ollama.md). |

Add a second one as backup with `--backup`, for example `msum provider use ollama --backup --model <model>`.

## API keys

**API keys never go in `config.json`**: a key written there is rejected, with a message that points to this section. Store it with:

```sh
msum secret set openai        # or anthropic, gemini; with --account <id> for a single account
```

- The key is read from the input (hidden while you type, or through a pipe: `msum secret set openai < key.txt`), never from an argument, which would show up in `ps` and in your shell history.
- It is stored in `secrets.json` in the data directory (`accounts/<id>/secrets.json` with `--account`), with 600 permissions, and is never printed or written to the logs.
- `msum secret ls` shows which providers have a key and where it comes from (never the key), and `msum secret rm <provider>` removes one.
- The key is looked up in this order: **environment variable** (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`), then `accounts/<id>/secrets.json`, then `secrets.json`.

### The two OpenAI keys

There are two OpenAI keys, so that the real one never goes to another server.

| Key | How to store it | When it is used |
|---|---|---|
| **`openai`** | `msum secret set openai`, or `OPENAI_API_KEY` | Only when the origin of `baseUrl` is exactly `https://api.openai.com`. |
| **`openai-compatible`** | `msum secret set openai-compatible`, or `MSUM_OPENAI_API_KEY` | For any other `baseUrl`. |

The same rule holds for the account and installation files and for the environment: a compatible server never receives the `openai` entry, and if it needs no key none is sent.

`msum doctor` says which one your configuration will use, verifies that the model is set, that a key exists and that `secrets.json` (the installation's and each account's) is readable only by your user, without connecting to anything.

## Usage limits and retries

- If a provider answers "too many requests", the program waits the time it indicates (`Retry-After`, or the wait time Gemini puts in the error) and retries.
- An overloaded server (503, 529) or a network error is retried with a growing wait.
- Each conversation has its own budget, by default 3 retries and 120 seconds of total waiting (`provider.retry.maxRetries` and `provider.retry.maxWaitMs`). The whole call, attempts and waits together, cannot exceed 300 seconds (`provider.retry.maxTotalMs`).
- A provider that redirects, or answers with more than 2 MB, makes the call fail: redirects are never followed, because they would forward your chat and your key to a server you did not choose.
- If that is not enough, that conversation goes to the backup provider if there is one. Otherwise the digest comes out with the conversations that could be summarized and says which were left out.

## Privacy: what each provider does with your data

**The text of your chats leaves your machine** for the provider you choose, except conversations matching `localOnlyPatterns` (Ollama summarizes those). What each one does with it, according to their own pages (check them, terms change):

- **OpenAI:** by default API data is not used to train its models, and abuse-monitoring logs are kept for up to 30 days. [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data).
- **Anthropic:** by default it does not train on the inputs or outputs of its commercial products, the API included. [Is my data used for model training?](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training)
- **Gemini:** with a free key (no billing), Google may use what you send to improve its products, and human reviewers may read it; with billing enabled that is not the usual case. **Do not use a free key for chats you would not want anyone to read**, and mark sensitive chats as local only. [Gemini API data logging and sharing](https://aistudio.google.com/docs/logs-policy).
- **Claude Code (`claude-cli`):** what Anthropic does depends on the account type: with a consumer plan (Free, Pro, Max) your data may be used to improve its models if that option is on, and is kept for 30 days or 5 years depending on it; under commercial terms (Team, Enterprise, API) it is not used for training. [Claude Code data usage](https://code.claude.com/docs/en/data-usage).

## Step-by-step guides

- [Getting a Google API key (Gemini)](get-google-api-key.md)
- [Installing Claude Code and signing in](install-claude-and-login.md)

---

Back to the [README](../../README.md) · [Guides index](README.md)

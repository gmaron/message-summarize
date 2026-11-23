# What the program connects to

Nothing is sent anywhere except what this guide lists. There is no telemetry, and transcription never opens a network connection. Back to the [README](../../README.md).

## Summary

| Destination | When | What is sent |
|---|---|---|
| WhatsApp | Whenever an account is connected | Your own account's connection; the download of audio you receive, if transcription is on. |
| The LLM provider you chose | When summarizing or answering an "Ask" request | The text of the conversations that are not "local only" and your prompt (or your request). |
| What Claude Code contacts | With `claude-cli` | Decided by the CLI itself (see below). |
| The provider's model list | When opening the wizard or Settings to choose a model | A `GET` with no chat text. |
| Your Ollama server | `msum ollama pull`, `msum doctor` or the model picker | The tag, or a request for the model list; no chat text. |
| Hugging Face | Only with `msum whisper download <name>` | The request for the model file. |

## In detail

### WhatsApp

Through your own account's connection (including the download of the audio you receive, when transcription is on).

### The LLM provider you chose

And nothing else: with Ollama, the URL you configured; with an API provider, exactly one of `api.openai.com` (or your `provider.openai.baseUrl`), `api.anthropic.com` or `generativelanguage.googleapis.com`.

- **The text of the conversations that are not local only is sent there**, together with your digest prompt.
- A request from the web's "Ask" tab sends the same thing, one conversation at a time, with your request instead of the digest prompt.
- Keys travel only in the request headers.

### With `claude-cli`: what Claude Code itself contacts

These are its maker's servers, according to [its network documentation](https://code.claude.com/docs/en/network-config):

- `api.anthropic.com`: the model requests, which carry the text of the conversations that are not local only, and its own operational telemetry.
- `claude.ai`, `claude.com`, `platform.claude.com` and `sso.claude.com`: sign-in.
- `http-intake.logs.us5.datadoghq.com` and `browser-intake-us5-datadoghq.com`: the CLI's optional telemetry, which its configuration can turn off (`DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`).

That traffic is the CLI's, not this program's, and the program does not pass it those variables: set them in Claude Code's configuration file. `gemini-cli` and `codex-cli` are disabled and contact nothing. A `generic-cli` command contacts whatever it does.

### Dictation in the "Ask" tab: what your browser contacts

The microphone button uses the browser's speech recognition (the Web Speech API). The program receives only the resulting text, and never the audio. Where the audio goes is decided by the browser: Chrome sends it to Google's servers, and Safari to Apple's. Typing the request instead sends nothing.

### The model list

When you open the wizard or the settings to choose a model:

- **With an API provider**, a `GET` to its model list (`/v1/models` on `api.openai.com` or on your `provider.openai.baseUrl`, on `api.anthropic.com`; `/v1beta/models` on `generativelanguage.googleapis.com`), made by the daemon with the key you already saved, to the host already declared for that provider and no other. No chat text, with a timeout, no redirects or retries, and the response is kept in memory for ten minutes. The key never reaches the page.
- **With Ollama**, a request for the installed models at the address you configured, or the one you typed on screen before saving it (`/api/tags`; an address that is not this machine's is queried only after you accept its notice), also from the page's model picker.
- Claude Code's models (`sonnet`, `opus`, `haiku`) are a fixed list and query nothing.
- The request is a `POST` from the page to the daemon, with the same origin check as any other write.
- If the list cannot be read, only Anthropic has a short list of known models (marked as such); for OpenAI and Gemini the page shows the error and a "Look again" button. A model is never typed in, except on a compatible server that cannot list its models.

### Your own Ollama server

When you run `msum ollama pull <tag>` or `msum doctor`: the tag to download, or a request for its model list, to the URL in `provider.ollama.baseUrl` and nowhere else; no chat text. The download is done by Ollama, not by this program.

### Hugging Face

Only when you run `msum whisper download <name>`: the model is downloaded from whisper.cpp's official repository, `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<name>.bin`.

- Hugging Face answers with a redirect to its content network: a request to that URL ends at **`us.aws.cdn.hf.co`** (verified with a `HEAD` request when this was written).
- The program follows redirects by itself, one at a time, and only to `https` addresses of `huggingface.co` or `*.hf.co`; any other server is rejected.
- Only the request for that file is sent, and each model's **checksum (SHA-256) and size are pinned in the program**: a file that does not match is discarded.

## What each provider does with your data

See [Privacy in the providers guide](providers.md#privacy-what-each-provider-does-with-your-data).

---

Back to the [README](../../README.md) · [Guides index](README.md)

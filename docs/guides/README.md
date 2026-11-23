# msum guides

Usage and reference guides, in English. [Español](../guias/README.md) · Back to the [README](../../README.md).

## To get started

- [How it works, explained without jargon](how-it-works.md): what problem the app solves and what happens from the moment a message arrives until you get the summary. For readers who do not program.

## Step by step, to get the provider ready

Short guides, no jargon. Their screenshots show the Spanish interface.

- [Getting a Google API key (Gemini)](get-google-api-key.md): to use Gemini as the provider.
- [Installing Claude Code and signing in](install-claude-and-login.md): to use "Claude (command line)" with your Claude plan.

Both guides were checked against the official pages on 2026-11-20. Providers change their screens and prices: when in doubt, their pages win.

## Reference

| Guide | What it explains |
|---|---|
| [Choosing and testing the LLM provider](providers.md) | Providers, `provider ls/use/test`, API keys, retries and each one's privacy. |
| [Using a CLI as a provider](cli-provider.md) | Claude Code and the generic CLI, the "no tools" rule and why Gemini CLI and Codex are disabled. |
| [Transcribing voice notes](transcription.md) | whisper.cpp, options, limits and the download queue. |
| [Choosing a local model (Ollama)](local-model-ollama.md) | Candidates, evaluation and the `msum ollama` commands. |
| [Importing from the previous tool](import-previous-tool.md) | `msum import`. |
| [What the program connects to](network-and-privacy.md) | Every network destination. |
| [The web page, the wizard and accounts](web-and-accounts.md) | The web, the first-run wizard, exclusions, agreements and asking about your chats. |
| [The daemon, accounts and schedules](daemon-and-schedules.md) | `config.json`, the daemon, blocks, several accounts and `msum schedule`. |

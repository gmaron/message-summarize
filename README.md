# message-summarize

[Español](README.es.md)

Reads the messages that arrive at your messaging account, summarizes them with the language model of your choice and sends you a periodic digest: which chats need a reply, what is still pending and what you can safely ignore.

The first supported platform is **WhatsApp**. The core does not depend on it, so other platforms (Telegram, Slack, email) can be added later as new adapters.

## Status

**In design. It cannot be used yet.** There is no installable version. This repository holds the approved requirements ([docs/requirements.md](docs/requirements.md), in Spanish) and the project skeleton. The code will be written in the phases listed in the [roadmap](#roadmap).

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

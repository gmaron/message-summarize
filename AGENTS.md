# AGENTS.md

Instructions for anyone, human or AI agent, working on this repository.

## What this is

message-summarize reads the messages that arrive at a messaging account, summarizes each conversation with an LLM and delivers a periodic digest to the user's own chat. WhatsApp (through Baileys) is the first platform; the core must not depend on it.

The project is in design. The approved requirements are in [docs/requirements.md](docs/requirements.md) (Spanish). Read them before changing behavior: every feature has an ID (RF-xx, RNF-xx) and an acceptance criterion.

## Stack

- Node 22 or later, ESM, TypeScript in strict mode.
- `node:sqlite` for storage. No native npm modules.
- Biome for lint and format, Vitest for tests.
- Web: Svelte 5 compiled with Vite, no component library, served as static files by the daemon.
- Scheduling inside the daemon with `croner`. Never write to the OS crontab or scheduler.

The tooling is not set up yet; it arrives in phase 1.

## Architecture

Ports and adapters. Dependencies only point inward.

```
src/
  domain/            entities and rules (Conversation, Participant, Message, digest policies)
  application/       use cases; ports/ holds the interfaces (MessageSource, DeliveryChannel, Summarizer, ...)
  infrastructure/    adapters: whatsapp, llm/api, llm/cli, persistence/sqlite, transcription, scheduling, rendering
  interfaces/        cli, http, web
  main/              composition root
test/
  unit/  contract/  golden/  fixtures/
```

- `domain/` and `application/` never import from `infrastructure/` or `interfaces/`.
- Platform-specific concepts (LID, the phone's unread counter, `read-self`) stay in the adapter, which translates them into domain events.
- A new platform or LLM provider is a new adapter that passes the contract tests of its port. It must not require changes in `domain/` or `application/`.

## Rules that protect users

These are not style preferences. Breaking them can get a user's WhatsApp number banned or leak private conversations.

- **Never send anything to third parties.** The digest goes only to the account's own chat. The WhatsApp delivery adapter must reject any other recipient, including another account linked in the same installation (RF-51).
- **Do not mark the client as online**, and do not add behavior that sends messages, automates replies or changes how the client connects (RNF-17).
- **LLM CLIs run without tools:** tools, MCP and session persistence disabled, in an empty temporary directory, with a timeout (RF-49). Chat text is written by third parties and must be treated as untrusted input.
- **"Local only" conversations never reach an external provider** (RF-43).
- **No telemetry, and no network calls beyond the declared ones** (RNF-01). Secrets and the WhatsApp session never appear in logs (RNF-04).
- **No real data in the repository.** Fixtures and golden files use made-up conversations, names and numbers.

## Tests

- **Golden files** (`test/golden/`) capture the behavior of the author's previous personal tool on made-up conversations. The new code must produce the same output. When a golden file changes, explain why in the commit.
- **Contract tests** (`test/contract/`): every adapter of a port passes the same suite.
- Coverage targets: 90% or more for `domain/`, 80% or more for use cases.

## Conventions

- Code, identifiers, commits and English docs in English. Design documents in `docs/` stay in Spanish until v0.1.0. The README exists in both languages: keep `README.md` and `README.es.md` in sync.
- Small commits with a clear message in the imperative mood.
- No user-facing text outside the translation files (Spanish and English).

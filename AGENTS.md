# AGENTS.md

Instructions for anyone, human or AI agent, working on this repository.

## What this is

message-summarize reads the messages that arrive at a messaging account, summarizes each conversation with an LLM and delivers a periodic digest to the user's own chat. WhatsApp (through Baileys) is the first platform; the core must not depend on it.

The project is at `0.1.0-rc1`, on its way to v0.1.0. Three documents in `docs/` (Spanish) describe it, each with one job:

- [docs/requirements.md](docs/requirements.md): the only spec. What the product does, one row per requirement with an ID (RF-xx, RNF-xx) and an acceptance criterion. Read it before changing behavior.
- [docs/arquitectura.md](docs/arquitectura.md): how it is built today: layers, processes, flows, ports and adapters, data on disk, where each area lives.
- [docs/decisiones.md](docs/decisiones.md): why, as dated one-line decisions, newest first.

## Stack

- Node 22 or later, ESM, TypeScript in strict mode.
- `node:sqlite` for storage. No native npm modules.
- Biome for lint and format, Vitest for tests.
- Web: Svelte 5 compiled with Vite, no component library, served as static files by the daemon.
- Scheduling inside the daemon with `croner`. Never write to the OS crontab or scheduler.

Scripts: `npm run lint` (Biome), `npm run typecheck` (tsc), `npm test` (Vitest), `npm run test:coverage` (Vitest with v8 thresholds), `npm run build` (tsc to `dist/`), `npm run test:mutation` (StrykerJS on `domain/` and `application/`), `npm run check:spec` (requirement IDs cited in the code exist in the spec). `npm run format` applies Biome fixes (it never touches Markdown). The full list is in [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md).

## Architecture

Ports and adapters. Dependencies only point inward.

```
src/
  domain/            entities and rules (Conversation, Participant, Message, digest policies)
  application/       use cases; ports/ holds the interfaces (DeliveryChannel, Summarizer, DigestSource, ...)
  infrastructure/    adapters: whatsapp, llm/api, llm/cli, persistence/sqlite, transcription, scheduling, rendering
  interfaces/        cli, http, web
  main/              composition root: config, daemon, CLI commands, web routes
test/
  unit/  contract/  golden/  fixtures/
```

- `domain/` and `application/` never import from `infrastructure/` or `interfaces/`.
- Platform-specific concepts (LID, the phone's unread counter, `read-self`) stay in the adapter, which translates them into domain events.
- Reading messages is not a port: a platform adapter translates its events into the capture events of `CaptureMessages` (`application/capture-events.ts`). Delivering is the `DeliveryChannel` port.
- A new platform or LLM provider is a new adapter that passes the contract tests of its port. It must not require changes in `domain/` or `application/`.

The details are in [docs/arquitectura.md](docs/arquitectura.md). A PR that changes the structure (a new port, layer, process or data file) updates that document in the same PR.

## Rules that protect users

These are not style preferences. Breaking them can get a user's WhatsApp number banned or leak private conversations.

- **Never send anything to third parties.** The digest goes only to the account's own chat. The WhatsApp delivery adapter must reject any other recipient, including another account linked in the same installation (RF-51).
- **Do not mark the client as online**, and do not add behavior that sends messages, automates replies or changes how the client connects (RNF-17). The only approved exceptions are opt-in full history on link and asking the own phone to re-upload old audios; both are described in RNF-17.
- **LLM CLIs run without tools:** tools, MCP and session persistence disabled, in an empty temporary directory, with a timeout (RF-49). Chat text is written by third parties and must be treated as untrusted input.
- **"Local only" conversations never reach an external provider** (RF-43).
- **No telemetry, and no network calls beyond the declared ones** (RNF-01). Secrets and the WhatsApp session never appear in logs (RNF-04).
- **No real data in the repository.** Fixtures and golden files use made-up conversations, names and numbers.

## Keeping the spec in order

- **The rule:** a PR that changes what the user sees or receives (web, CLI, digest, a privacy or security rule) changes its row in `docs/requirements.md` in the same PR, and the test that covers it cites the ID (in the `describe` or `it` name). A refactor, a test or a dependency bump does not touch the spec.
- **New requirement:** a new row with the next free number of the whole document, in the section it belongs to. IDs are never reused.
- **Contradicting an earlier row or decision:** add a dated line to `docs/decisiones.md`.
- No per-feature specs, design documents per PR or hand-kept traceability tables. `npm run check:spec` runs in CI.

## Tests

- **Golden files** (`test/golden/`) capture the behavior of the author's previous personal tool on made-up conversations. The new code must produce the same output. When a golden file changes, explain why in the commit.
- **Contract tests** (`test/contract/`): every adapter of a port passes the same suite.
- Coverage targets: 90% or more for `domain/`, 80% or more for use cases.

## Conventions

- Code, identifiers, commits and English docs in English. Design documents in `docs/` stay in Spanish until v0.1.0. The README exists in both languages: keep `README.md` and `README.es.md` in sync.
- Small commits with a clear message in the imperative mood.
- No user-facing text outside the translation files (Spanish and English).

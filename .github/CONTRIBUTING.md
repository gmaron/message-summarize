# Contributing

Thanks for your interest in message-summarize. Read [AGENTS.md](../AGENTS.md) first: it is the reference for the architecture and the rules, and it applies to humans and AI agents alike. The approved requirements are in [docs/requirements.md](../docs/requirements.md) (in Spanish); every feature has an ID (RF-xx, RNF-xx) and an acceptance criterion. Read them before changing behavior.

## Set up

You need Node 22.16 or later.

```sh
git clone https://github.com/gmaron/message-summarize.git
cd message-summarize
npm ci
```

## Scripts

| Script | What it does |
|---|---|
| `npm run lint` | Biome lint and format check. |
| `npm run format` | Applies Biome fixes. It never touches Markdown. |
| `npm run typecheck` | TypeScript (strict) for the core, the whole project and the web, plus `svelte-check`. |
| `npm test` | Vitest, the whole suite. |
| `npm run test:coverage` | Vitest with the v8 coverage thresholds (90% for `domain/`, 80% for use cases). |
| `npm run build` | Compiles to `dist/` and builds the web. |
| `npm run check:licenses` | Walks the production dependencies and fails on a license outside the allowlist (RNF-18). The known `libsignal` exception is reported, not hidden. |
| `npm run check:dist` | Fails when the build output or the packaged files are missing or stale. Run it after `npm run build`. |
| `npm run check:web-size` | Fails when the web JavaScript is over 100 KB gzipped (RNF-19). |
| `npm run notices` | Regenerates `THIRD_PARTY_NOTICES.md`. Never edit that file by hand. |
| `npm run notices:check` | Fails when `THIRD_PARTY_NOTICES.md` does not match the installed production dependencies. |

When you change a dependency, run `npm ci` and then `npm run notices`, and commit the updated file.

## Pre-push check

`.githooks/pre-push` runs what the quality job of CI runs (`lint`, `typecheck` and `test:coverage`, about a minute) and stops the push when one fails. Enable it once per clone:

```sh
git config core.hooksPath .githooks
```

To skip it for one push, use `MSUM_SKIP_CHECKS=1 git push`. CI still runs everything, plus the build, the installers and the other operating systems.

## Architecture in one screen

Ports and adapters. Dependencies only point inward.

```
src/
  domain/            entities and rules
  application/       use cases; ports/ holds the interfaces
  infrastructure/    adapters: whatsapp, llm, persistence, transcription, scheduling, rendering
  interfaces/        cli, http, web
  main/              composition root
test/
  unit/  contract/  golden/  fixtures/
```

- `domain/` and `application/` never import from `infrastructure/` or `interfaces/`.
- Platform-specific concepts stay in the adapter. A new platform or LLM provider is a new adapter that passes the contract tests of its port, with no change in `domain/` or `application/`.
- No user-facing text outside the translation files (Spanish and English).

See [AGENTS.md](../AGENTS.md) for the details.

## Rules that protect users

These are not style preferences: breaking them can get someone's number banned or leak private conversations. [AGENTS.md](../AGENTS.md) has the full text. In short:

- Never send anything to third parties: the digest goes only to the account's own chat.
- Never mark the client as online, and never add behavior that sends messages or automates replies.
- LLM CLIs run without tools, in an empty temporary directory, with a timeout. Chat text is untrusted input.
- "Local only" conversations never reach an external provider.
- No telemetry and no undeclared network calls. Secrets and the WhatsApp session never appear in logs.

## No real data, ever

Real conversations, names, phone numbers, sessions, API keys and config files never go into the repository: not in code, tests, fixtures, golden files, issues or pull requests. Make everything up. If you need to show a bug, reduce it to an invented conversation.

## Tests

- **Golden files** (`test/golden/`) capture the expected output on made-up conversations. The new code must produce the same output. When a golden file changes, explain why in the commit message.
- **Contract tests** (`test/contract/`): every adapter of a port passes the same suite. A new adapter comes with its run of that suite.
- Add or update tests with every behavior change. Keep the coverage thresholds.

## Commits and pull requests

- Code, identifiers, commits and English docs are in English. Design documents in `docs/` stay in Spanish until v0.1.0.
- Small commits with a clear message in the imperative mood ("Add the schedule editor", not "Added" or "Adds").
- `README.md` and `README.es.md` must stay in sync.
- Open pull requests against `main`. Say which requirement IDs the change touches and what you ran.

## Continuous integration

CI is required on every pull request (RNF-15) and runs on GitHub Actions:

- **quality** (Linux): `check:licenses`, `notices:check`, lint, typecheck, tests with coverage, build, `check:dist` and `check:web-size`.
- **test** on Linux, macOS and Windows, with Node 22 and 24: the whole suite, so a change cannot break one operating system.
- **install-smoke** on each OS: installs from the packed tarball into a temporary home.
- **Docker**: builds the image and runs the compose smoke test on every pull request. A multi-architecture build (amd64 and arm64, base and `cli` images, nothing published) runs only on pushes to `main` and by hand.

Run lint, typecheck and the tests you touched before you push. The workflow files are in `.github/workflows/`.

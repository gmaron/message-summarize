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
| `npm run test:mutation` | StrykerJS mutation testing on `domain/` and `application/`. Slow: not part of CI. |
| `npm run check:spec` | Fails when the code or the tests cite a requirement ID that is not in `docs/requirements.md`, and lists the `v1` requirements no test cites. |
| `npm run build` | Compiles to `dist/` and builds the web. |
| `npm run check:licenses` | Walks the production dependencies and fails on a license outside the allowlist (RNF-18). The known `libsignal` exception is reported, not hidden. |
| `npm run check:dist` | Fails when the build output or the packaged files are missing or stale. Run it after `npm run build`. |
| `npm run check:web-size` | Fails when the web JavaScript is over 100 KB gzipped (RNF-19). |
| `npm run notices` | Regenerates `THIRD_PARTY_NOTICES.md`. Never edit that file by hand. |
| `npm run notices:check` | Fails when `THIRD_PARTY_NOTICES.md` does not match the installed production dependencies. |

When you change a dependency, run `npm ci` and then `npm run notices`, and commit the updated file.

## Pre-push check

`.githooks/pre-push` runs what the quality job of CI runs (`lint`, `typecheck` and `test:coverage`, about a minute) and stops the push when one fails. It skips them when everything you push is documentation (Markdown at the root, `docs/`, `.github/*.md`, `LICENSE`) or a branch deletion. Enable it once per clone:

```sh
git config core.hooksPath .githooks
```

To skip it for one push, use `MSUM_SKIP_CHECKS=1 git push`. CI still runs everything, plus the build, the installers and the other operating systems.

## Architecture and rules

[AGENTS.md](../AGENTS.md) has the architecture rules and the rules that protect users; read it before your first change. Breaking those rules can get someone's number banned or leak private conversations. How the code is organized today (layers, processes, flows, ports and adapters, data on disk) is in [docs/arquitectura.md](../docs/arquitectura.md).

## Requirements and decisions

- A change in what the user sees or receives updates its row in [docs/requirements.md](../docs/requirements.md) in the same pull request, and the test that covers it cites the ID.
- A change that contradicts an earlier row or decision adds a dated line to [docs/decisiones.md](../docs/decisiones.md).
- Refactors, tests and dependency bumps do not touch the spec.

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
- Open pull requests against `main`. The template asks which requirement IDs the change touches and what you ran.

## Continuous integration

CI is required on every pull request (RNF-15) and runs on GitHub Actions:

- **quality** (Linux): `check:licenses`, `notices:check`, `check:spec`, lint, typecheck, tests with coverage, build, `check:dist` and `check:web-size`.
- **test** on Linux, macOS and Windows, with Node 22 and 24: the whole suite, so a change cannot break one operating system.
- **install-smoke** on each OS: installs from the packed tarball into a temporary home.
- **Docker**: builds the image and runs the compose smoke test on every pull request. A multi-architecture build (amd64 and arm64, base and `cli` images, nothing published) runs only on pushes to `main` and by hand.

Run lint, typecheck and the tests you touched before you push. The workflow files are in `.github/workflows/`.

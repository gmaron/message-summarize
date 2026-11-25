# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who receive more messages than they can read and want to know what needs their attention. They are not technical: they use the local web and do not need to know what a cron is. An installation often has two or more messaging accounts (for example, personal and work).

The digest reaches them in their own WhatsApp chat. After the first-use wizard, they open the web occasionally, as a control panel: to check that every account is working, adjust schedules, exclude or protect conversations, edit the prompt, and find out why a digest failed.

## Product Purpose

message-summarize reads the messages that arrive at a messaging account, summarizes each conversation with the LLM the user chooses and delivers a periodic digest to the account's own chat. Success: the user stops scrolling through every chat and still answers what matters.

## Positioning

Runs entirely on the user's machine, with the LLM they already pay for or a local one. The digest only ever goes to the account's own chat, never to a third party or another account. Conversations marked "local only" never leave the machine.

## Operating Context

- A daemon on the user's machine serves the web on `127.0.0.1` with an access token; `msum open` opens it.
- Live updates over SSE: link QR, sync progress, digest progress, account state.
- Per account: state (connected, reconnecting, session closed, error, blocked), schedules, conversations, settings, prompt, history of runs. Installation-wide: logs.
- First use goes through a wizard: language, name, provider (with test and consent), transcription, QR, sync, first schedule. It can be resumed.

## Capabilities and Constraints

- What the web must do, with IDs and acceptance criteria, is in `docs/requirements.md` (Spanish), mainly sections 4.1, 4.7 and 4.8. That file wins over anything here.
- Svelte 5 compiled with Vite, no component library, served as static files by the daemon. JS bundle under 100 KB gzip (RNF-19).
- Every user-facing string lives in the Spanish and English translation files.
- No telemetry and no network calls beyond the declared ones: no external fonts or CDNs at runtime.
- The daemon decides every action; the page only reflects what it allows.

## Brand Commitments

Name: message-summarize, CLI alias `msum`. No logo or visual identity exists yet.

## Evidence on Hand

No real data may appear in the repository, screenshots or fixtures: conversations, names and numbers are made up.

## Product Principles

1. Privacy is visible: what leaves the machine, and to whom, is always stated before it happens.
2. Problems come first: an account that is not working says so, says why, and offers the fix.
3. The user is not technical: plain language, no jargon about crons, LIDs or tokens.
4. Light and local: nothing loads from the internet, and the page stays small.

## Accessibility & Inclusion

Keyboard and screen-reader use across the web (labels, live regions for progress and status). Light and dark themes follow the system.

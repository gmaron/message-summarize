# Golden files

These files freeze what the author's previous personal tool produced for a set of made-up conversations. The new code must produce the same output from the same input. When a golden file changes, the commit must explain why.

## What is here

```
generate.mjs                 generator
scenarios/NN-slug.mjs        input: config, prompt, chats, contacts, messages, state,
                             fixed LLM responses and the runs to execute
NN-slug/run-K/
  llm-input.json             system prompt + every chat sent to the LLM, with its exact text
  whatsapp-parts.json        the parts of the WhatsApp message added to the outbox in this run
  digest.md                  the full digest file (absent when the run wrote none)
  state.json                 last_summary_ts after the run, and the whole outbox
  stdout.txt                 what the tool printed
```

Each scenario starts with a comment that names the rule it covers, lists its cases and explains why the order of the data does not make it pass by accident. All names, numbers and texts are invented.

| Scenario | Rule |
|---|---|
| 01-sections-and-order | Sections and order: priority, then message count |
| 02-unsaved-flag-on | Names of unsaved contacts; `sinAgendarEnRojo` on |
| 02-unsaved-flag-off | The same data with `sinAgendarEnRojo` off |
| 03-own-mass-messages | Own mass messages: 40+ characters in 3+ chats; chats where only I wrote |
| 03-own-mass-in-context | The "mensaje masivo tuyo" label, which only appears in the context block |
| 04-repeated-group-notices | Notices repeated across groups and the "(mismo mensaje en N grupos más)" note |
| 05-unread-only | `soloNoLeidos`: `unread_count` -1, 0, null and N; read flags; 5-message context |
| 06-truncation | Truncation by `maxCaracteresPorChat` |
| 07-audios | Audios with and without a transcript |
| 08-exclusions | Exclusion by name and by identifier |
| 09-hide-rest-on | `ocultarResto` on; splitting the message into parts of 3500 characters |
| 09-hide-rest-off | The same data with `ocultarResto` off |
| 10-window-and-pointer | Window and pointer: it never goes back, `--dry-run` does not move it, empty window |
| 11-llm-error | LLM errors and the "⚠️ N chats no se pudieron resumir" line |

`listener.js` is not covered here. It belongs to the contract tests of phase 1.

## Regenerating

```sh
node test/golden/generate.mjs --legacy ~/workspace/personal/summaryzing-whatsapp [slug ...]
```

Without slugs it runs every scenario. It needs Node 22.13 or later (23.4 or later on Node 23). The committed files were generated with Node 26.7.0.

How it works:

- **The legacy project is only read.** The generator copies four of its files (`src/summarize.js`, `config.js`, `db.js`, `prompt.js`) into a temporary directory and never writes inside the legacy path. No legacy code is stored in this repository.
- **Fakes.** In that copy, `llm.js` is replaced by a fake that returns the scenario's fixed responses and records what it receives, and `transcribe.js` by one that does nothing. `config.json` and `prompt.md` come from the scenario.
- **Database.** It is seeded through the legacy `db.js`, so the schema and migrations are the legacy ones.
- **Environment.** Each run executes `summarize.js` with a minimal environment: `PATH`, `TZ=America/Argentina/Buenos_Aires`, a temporary `HOME` and data directory. No API keys are passed and nothing reaches the network.
- **Atomic output.** Outputs are written to a staging directory and replace `test/golden/<slug>` only when every run of the scenario succeeds.

The generator fails when:

- a scenario has no runs, or a scenario name passed on the command line does not exist;
- a run has no `--hasta`, or `--desde`/`--hasta` are not in the form `YYYY-MM-DD HH:MM`, or they use the `--flag=value` form, or a flag is repeated, or `--horas` is used. These would make the output depend on the clock. `--desde` is optional: without it the window starts at the pointer, or at `--hasta` minus `horasPorDefecto`.
- two messages share a timestamp, because SQLite's order on ties is undefined;
- a chat is sent to the LLM without a fixed response, or a fixed response is never used;
- a run writes more than one digest file;
- seeding the database fails, or the tool exits with an error.

What can still vary: dates are formatted with the `es-AR` locale, so a Node version with different ICU data could change them. `outbox.created_at` comes from `Date.now()` and is left out of `state.json`.

### Checking that a scenario tests its rule

A golden file only protects a rule if breaking the rule changes the output. Every case was checked this way:

1. Copy the four legacy files into a scratch directory, keeping the `src/` layout.
2. Break one rule in that copy.
3. Point `--legacy` at the copy.
4. Confirm the output differs.

Run the mutated copy against a copy of `test/golden/`, not against the repository, because the generator writes into `test/golden/<slug>`.

One case cannot be caught: in 05, Bruno has `unread_count` 0. Without the `!count` guard, `LIMIT 0` returns nothing anyway, so the output is the same with or without it.

## Inherited behavior (comportamiento heredado)

These are odd behaviors of the legacy tool. They are frozen as they are, because the goal of phase 0 is to reproduce the old output exactly. Whether the new code keeps each one is a decision for later phases, and changing one means changing its golden file in a commit that explains why.

### Texts and format

- **No singular forms in some lines.** The tool writes "1 chats con novedades" (03-own-mass-in-context, 09, 10), "1 necesitan respuesta" (02-unsaved-flag-on, 03-own-mass-in-context, 06, 09, 10, 11) and "⚠️ 1 chats no se pudieron resumir" (11). The hidden-rest line does use "chat" for 1 (09-hide-rest-on). The code also uses "chat" for 1 in the "Sin agendar" title, but no scenario has a single unsaved chat, so that case is not frozen.
- **Dates have no year.** They use `es-AR` with a short weekday, for example "mar 10-03, 20:00". (all)
- **The digest file has no trailing newline.** (all)
- **The digest file name is in UTC.** It comes from the UTC time of `--hasta` (`toISOString`), while the title uses local time. The goldens do not store file names.
- **Unsaved contacts get spaces inside the parentheses.** They are shown as `alias ( +number )`, so WhatsApp detects the number and makes it tappable. (02)
- **Masked names are dropped.** Every time `db.js` opens the database, it sets to NULL any contact name or chat name that contains "∙", the character WhatsApp uses in masked numbers ("+54∙∙∙∙15"). A contact whose agenda name was masked therefore counts as unsaved. (02-unsaved-flag-on, 02-unsaved-flag-off)
- **Context lines show only the time.** A message from the day before looks like one from the same day. (05)
- **The "Necesitan respuesta" count in the headline skips unsaved chats.** With `sinAgendarEnRojo` on, it leaves out unsaved chats that need a reply, because they are listed under "Sin agendar". (02)

### Window, pointer and errors

- **The window is `ts >= since AND ts < hasta`.** A message exactly at `--hasta` belongs to the next run. (10)
- **`--dry-run` still writes the digest file.** It does not touch the outbox or the pointer. (10)
- **An empty window still advances the pointer.** It writes no digest and nothing to the outbox. (10)
- **The pointer advances even when the LLM fails, so failed chats are never retried.** (11)
- **When every chat fails, a digest is still queued.** It has a "0 chats" headline and only the warning line. (11)
- **The text of each LLM error is not shown anywhere.** stdout says only "error" and the digest only the count. (11)

### Filters

- **Exclusion is a case-insensitive substring match on `"<jid> <resolved name>"`.** So "ana" also excludes "Mariana", and a pattern with "+" only matches the number shown in an unsaved contact's name, never the jid. The push name and the chats table name of a saved contact are ignored. (08)
- **Own mass messages are detected on the whole database.** That includes messages outside the window, of any kind and in any chat. The length is counted by SQLite in code points, so a text with an emoji can be 39 for SQLite and 40 for JavaScript. (03)
- **The "mensaje masivo tuyo" label only appears in the context block.** Mass messages are removed from the messages to summarize before they are rendered. The label collapses whitespace, cuts the text at 60 UTF-16 units and always appends "…", even when nothing was cut. (03-own-mass-in-context)
- **A repeated group notice is kept in the first group in chat order.** Chat order is the order of each chat's first message, not of the notice itself. (04)
- **How repeated notices are counted:**
  - A text repeated inside the same group is counted as "1 grupo más".
  - Senders without a jid or name share the key "?".
  - My own messages share the key "yo".
  - The 40-character threshold is measured after trimming.

  (04)
- **The "only I wrote" filter runs twice.** The second time is after group deduplication, so a group left with only my messages disappears. (03, 04)
- **How unread messages are chosen with `soloNoLeidos`:** (05)
  - They are the last N incoming messages of the whole chat (N is `unread_count`), not only of the window. Messages after `--hasta` also take some of those N places, so a chat whose last N incoming messages all arrived after the window is skipped.
  - Messages with `read = 1` are filtered out after taking those N, so fewer than N can count as unread.
  - The transcript starts at the first unread message inside the window. An unread message from before the window, or one with `read = 0` that is not among the last N, ends up in the context block, which is labeled "ya leídos".
  - A chat with `unread_count` null is skipped, the same as 0. Only -1 (marked as unread by hand) summarizes the whole window.

### Truncation and splitting

- **Truncation keeps the last `maxCaracteresPorChat` UTF-16 units.** It can cut a line in the middle, or split an emoji and leave half of it. Context is added after the cut and does not count toward the limit. (06)
- **The message is split only between lines:**
  - A line longer than 3500 stays whole as an oversized part.
  - A blank line before a section is handled in one of two ways. If the blank line still fits but the section title does not, the part ends with a trailing `\n` and the next part starts with the title. If the part is already full or oversized, the blank line is dropped, so no part starts with a blank line.

  (09)
- **An audio's caption is ignored.** An empty transcript renders the same as a missing one: "🎤 (audio sin transcribir)". (07)

## Legacy failures that are not frozen

A golden file cannot freeze a crash, so these cases have no scenario. Phase 1 decides what the new code does. The reasonable choice is to not fail.

- **A message with no text that is not an audio, inside a group, makes the tool crash.** An image without a caption is an example: `m.text.trim()` is called on `null`. In an individual chat the same message is rendered as "null". That case is not covered either.
- **Missing config keys have no default, and each one fails in a different way:**
  - Without `excluir` the tool crashes.
  - Without `horasPorDefecto`, a run with no pointer and no `--desde` gets a NaN start. The query returns no messages, the tool prints "No hubo mensajes nuevos para resumir." and the pointer still advances to `--hasta`. Those messages are silently lost.
  - Without `maxCaracteresPorChat` the transcript is never truncated.
- **An unknown `prioridad` sorts inconsistently.** The priority difference for a value outside alta/media/baja is NaN, which is falsy, so the comparison falls back to the message count. Between known priorities the sort still uses the priority, so the comparison is not transitive and the final order depends on the input.

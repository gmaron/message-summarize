---
version: 1
slug: "src-interfaces-web-app-svelte"
primary_target: "src/interfaces/web/App.svelte"
related_targets: []
---

# Web local de message-summarize

Scope: the whole local web (shell, accounts home, account tabs, digest reader, add/link, logs). Mode: Operate.
Audience: non-technical people with 2+ messaging accounts; occasional admin visits to check health, fix problems, tune schedules, conversations and prompt. The digest itself reaches them in their own chat.
Flows approved 2026-11-18: hash routes, accounts home with problems first, account tabs (Resumen, Conversaciones, Horarios, Historial, Ajustes + Prompt), digest reader for preview and run detail, Agregar cuenta and Vincular as pages, Logs filtered by account. Modals only for short confirmations.
Prototype first as an artifact with made-up data, then the Svelte build.

## Direction contract

THESIS: The web shows the digest exactly as it lands in your own chat, and everything else frames that message. Refuses the grey card dashboard where the digest is a row in a table.
OWN-WORLD: Warm stone ground, slate-ink rail, white message bubble with a squared top-left corner, sea-green for delivered and connected, brick for problems. One system sans at a tight 1.125 scale; tabular numerals for times and counts.
STORY: The visitor sees which accounts are fine and which need them, reads what their last digest said, and fixes or tunes in one click.
FIRST VIEWPORT: Slate rail left (accounts with avatar initial and state, then Agregar cuenta, Logs). Center: account name, state pill, tabs, then the last digest as a bubble with its sections. Right column: problem notice, next digest, Resumir ahora (primary), Vista previa.
FORM: Grounded safer-register candidate "Tu chat", position 2 of the safer lineup; seed:b64f98e6fcf35329.
Signature interaction: the digest bubble is the one reader everywhere (summary, preview, history run), with delivery ticks that change as a run progresses.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

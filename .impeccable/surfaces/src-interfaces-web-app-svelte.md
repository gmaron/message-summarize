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
OWN-WORLD: White ground, light grey rail and bubble (#f5f5f7), near-black ink as the one accent, flat message bubble with 16px corners and no tail; green for connected and delivered, brick for problems, amber for busy, always with words. Light only; one system sans with tabular numerals for times and counts.
STORY: The visitor sees which accounts are fine and which need them, reads what their last digest said, and fixes or tunes in one click.
FIRST VIEWPORT: Light rail left (msum wordmark with its ink tile, accounts with avatar initial and state dot, then Agregar cuenta, Logs). Center: account name, state pill, segmented tabs, then the last digest as a flat bubble with its sections. Right column: problem notice, next digest, Resumir ahora (primary, ink), Vista previa.
FORM: Grounded safer-register candidate "Tu chat", position 2 of the safer lineup; seed:b64f98e6fcf35329.
Signature interaction: the digest bubble is the one reader everywhere (summary, preview, history run), with delivery ticks that change as a run progresses.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

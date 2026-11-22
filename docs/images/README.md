# Images of the README

- `diagrams/`: `overview`, `privacy` and `architecture`, each as an editable `.excalidraw` source (open it at
  excalidraw.com or in the Excalidraw extension) and a rendered `.svg` (exported by Excalidraw itself).
- `diagrams/flujo-*`: six flow charts in Spanish for the guide [Cómo funciona](../guias/como-funciona.md) (`flujo-general`,
  `flujo-primer-uso`, `flujo-mensaje`, `flujo-resumen`, `flujo-privacidad`, `flujo-sesion`). Same pipeline and palette,
  built with the `flowKit` helpers (steps, pills, decisions, notes, labelled arrows).
- `screenshots/`: the web page as the README shows it, 1280 px wide, device scale 2, light theme. Every name, chat and
  id on them is made up. Phone ids are `99` (a country code that does not exist) followed by ten random digits, and
  group ids are `120363` followed by twelve random digits, so none can be a real number.

## Regenerate the diagrams

`generate-diagrams.mjs` holds the diagrams as data (palette of `DESIGN.md`, Helvetica, roughness 0), writes the
`.excalidraw` files and renders the SVGs with `exportToSvg` inside a headless Google Chrome. Nothing is installed in
this repository: the tooling lives in a folder outside it.

```sh
mkdir /path/to/tools && cd /path/to/tools && npm init -y
npm i playwright-core@1.65.1 @excalidraw/excalidraw@0.18.1 react@18.3.1 react-dom@18.3.1 esbuild
cd /path/to/message-summarize
DIAGRAM_TOOLS=/path/to/tools node docs/images/generate-diagrams.mjs        # all
DIAGRAM_TOOLS=/path/to/tools node docs/images/generate-diagrams.mjs privacy # one
```

Versions used: Node 26.7.0, `@excalidraw/excalidraw` 0.18.1, `playwright-core` 1.65.1 (drives the installed Google
Chrome with `channel: 'chrome'`, so no browser is downloaded), React 18.3.1, esbuild (latest at the time, 0.28.2).

The SVG text uses the system Helvetica (fallback Arial), so it renders the same on GitHub. Each SVG has a `<title>` for
accessibility.

## Screenshots

They were taken with Playwright against a built daemon (`npm run build`, then `msum daemon`) whose `MSUM_DATA_DIR`
was a throwaway folder, bound to 127.0.0.1. The first three (`wizard-*`) come from a fresh data directory. The
others come from an account database filled with invented conversations and digests; the account has no WhatsApp
session, so the daemon leaves it idle and never opens a connection. There is no script for them in the repository
on purpose: it would be a second place that knows the database schema.

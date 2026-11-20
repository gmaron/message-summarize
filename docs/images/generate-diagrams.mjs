// Generates the diagrams of the README: an editable `<name>.excalidraw` and a rendered `<name>.svg` for each.
//
// Nothing is installed in this repository. Tooling lives in a folder of your choice (DIAGRAM_TOOLS) that holds
// node_modules with: playwright-core, @excalidraw/excalidraw, react, react-dom and esbuild (see docs/images/README.md).
// The SVG is exported by Excalidraw itself (`exportToSvg`) inside a headless Google Chrome.
//
//   DIAGRAM_TOOLS=/path/to/tools node docs/images/generate-diagrams.mjs [name ...]

import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tools = process.env.DIAGRAM_TOOLS
if (!tools) throw new Error('Set DIAGRAM_TOOLS to the folder whose node_modules holds the tooling.')
const need = createRequire(join(resolve(tools), 'package.json'))
const { chromium } = need('playwright-core')
const esbuild = need('esbuild')

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'diagrams')

// Palette of DESIGN.md.
const INK = '#1d1d1f'
const INK2 = '#515154'
const MUTE = '#6e6e73'
const GROUND = '#ffffff'
const GROUND2 = '#f5f5f7'
const LINE = '#d2d2d7'
const OK = '#2e7d5b'
const BAD = '#b4412f'
const FONT = 2 // Helvetica

/** One diagram: skeleton elements for Excalidraw plus the x center each free text must be placed at. */
function builder() {
  const elements = []
  const centers = {}
  let n = 0
  const text = (cx, y, value, { size = 16, color = INK, group, id = `t${++n}` } = {}) => {
    elements.push({
      type: 'text',
      id,
      x: cx,
      y,
      text: value,
      fontSize: size,
      fontFamily: FONT,
      strokeColor: color,
      textAlign: 'center',
      ...(group ? { groupIds: [group] } : {}),
    })
    centers[id] = cx
    return id
  }
  /** A card: a rectangle with a title and an optional detail, grouped so they move together in Excalidraw. */
  const card = (
    id,
    x,
    y,
    w,
    h,
    title,
    detail,
    { fill = GROUND, stroke = LINE, dashed = false, titleColor = INK } = {},
  ) => {
    const group = `g-${id}`
    elements.push({
      type: 'rectangle',
      id,
      x,
      y,
      width: w,
      height: h,
      backgroundColor: fill,
      fillStyle: 'solid',
      strokeColor: stroke,
      strokeWidth: 1,
      strokeStyle: dashed ? 'dashed' : 'solid',
      roughness: 0,
      roundness: { type: 3 },
      groupIds: [group],
    })
    if (!title) return
    const lines = detail ? detail.split('\n').length : 0
    const block = 22 + (lines ? 6 + lines * 18 : 0)
    const top = y + (h - block) / 2
    text(x + w / 2, top, title, { size: 18, color: titleColor, group })
    if (detail) text(x + w / 2, top + 28, detail, { size: 14, color: titleColor === GROUND ? LINE : MUTE, group })
  }
  const arrow = (id, from, to, { dashed = false, both = false, color = INK2 } = {}) => {
    elements.push({
      type: 'arrow',
      id,
      x: 0,
      y: 0,
      start: { id: from },
      end: { id: to },
      strokeColor: color,
      strokeWidth: 1.5,
      strokeStyle: dashed ? 'dashed' : 'solid',
      roughness: 0,
      endArrowhead: 'arrow',
      startArrowhead: both ? 'arrow' : null,
    })
  }
  return { elements, centers, text, card, arrow }
}

function overview() {
  const d = builder()
  d.card('web', 270, 40, 210, 64, 'Web page', '127.0.0.1:8787')
  d.card('cli', 510, 40, 210, 64, 'CLI', 'msum link, digest, ...')
  d.card('daemon', 260, 150, 490, 200, '', '', { fill: GROUND2 })
  d.text(505, 164, 'msum daemon, on your machine', { size: 15, color: MUTE })
  d.card('capture', 280, 215, 130, 100, 'Capture', 'messages,\nread-only')
  d.card('sqlite', 440, 215, 130, 100, 'SQLite', 'in the data\ndirectory')
  d.card('schedules', 600, 215, 130, 100, 'Schedules', 'one digest\nper time set')
  d.card('wa', 20, 215, 160, 100, 'WhatsApp', 'your phone and\nthe linked device')
  d.card('llm', 860, 215, 140, 100, 'LLM provider', 'API, CLI or\nOllama (local)')
  d.card('chat', 400, 410, 210, 84, 'Your own chat', '"Message yourself"')
  d.arrow('a-web', 'web', 'daemon')
  d.arrow('a-cli', 'cli', 'daemon')
  d.arrow('a-wa', 'wa', 'capture')
  d.arrow('a-cap', 'capture', 'sqlite')
  d.arrow('a-sql', 'sqlite', 'schedules')
  d.arrow('a-llm', 'schedules', 'llm', { both: true })
  d.arrow('a-chat', 'daemon', 'chat')
  d.text(220, 232, 'messages', { size: 14, color: MUTE })
  d.text(805, 226, 'chat text\nand summary', { size: 14, color: MUTE })
  d.text(548, 372, 'digest', { size: 14, color: MUTE })
  return d
}

function privacy() {
  const d = builder()
  d.card('stays', 20, 20, 480, 450, '', '', { fill: GROUND2 })
  d.text(260, 38, 'Stays on your machine', { size: 22, color: OK })
  const grid = [
    ['db', 'SQLite database', 'in the data directory'],
    ['msgs', 'Your messages', 'the text of every chat'],
    ['voice', 'Voice notes', 'the audio stays here and\nwhisper.cpp transcribes it'],
    ['session', 'WhatsApp session', 'never written to the logs'],
    ['secrets', 'Secrets', 'API keys, readable only by you'],
    ['hist', 'Digest history', 'every digest, saved here'],
  ]
  grid.forEach(([id, title, detail], i) => {
    d.card(id, 40 + (i % 2) * 230, 90 + Math.floor(i / 2) * 90, 210, 74, title, detail)
  })
  d.card(
    'ollama',
    40,
    360,
    440,
    96,
    'Your Ollama server',
    '"Local only" chats go only to it. On this machine,\nnothing leaves; on another computer,\nthose chats go to that server',
  )
  d.card('leaves', 540, 20, 400, 450, '', '', { fill: GROUND })
  d.text(740, 38, 'Leaves your machine', { size: 22, color: BAD })
  d.card(
    'provider',
    560,
    90,
    360,
    200,
    'The provider you chose',
    'API (OpenAI, Anthropic, Gemini) or a CLI.\nIt receives the text of the conversations\nnot marked "local only", the names of chats\nand contacts, the numbers you have not\nsaved, voice-note transcripts and\nyour name as the owner',
    { stroke: BAD },
  )
  d.card(
    'owner',
    560,
    320,
    360,
    110,
    'Your own chat',
    'The digest goes only here, through your\nWhatsApp account ("Message yourself")',
    { stroke: BAD },
  )
  d.arrow('a-prov', 'msgs', 'provider', { color: BAD })
  d.arrow('a-own', 'hist', 'owner', { color: BAD })
  d.card(
    'nothing',
    20,
    495,
    920,
    70,
    'Besides the provider: only your own chat, WhatsApp and the listed requests',
    'See "What the program connects to". This program has no telemetry.',
    { fill: GROUND2 },
  )
  return d
}

function architecture() {
  const d = builder()
  d.card('main', 20, 20, 920, 80, 'main/', 'composition root: wires the adapters to the use cases', {
    dashed: true,
    fill: GROUND,
  })
  d.card('interfaces', 20, 190, 420, 110, 'interfaces/', 'cli, http, web', { fill: GROUND2 })
  d.card(
    'infra',
    500,
    190,
    440,
    110,
    'infrastructure/',
    'whatsapp, llm/api, llm/cli, persistence/sqlite,\ntranscription, scheduling, rendering',
    { fill: GROUND2 },
  )
  d.card(
    'app',
    200,
    400,
    560,
    100,
    'application/',
    'use cases, and ports/, the interfaces they need:\nMessageSource, DeliveryChannel, Summarizer, ...',
    { fill: GROUND2, stroke: INK },
  )
  d.card(
    'domain',
    200,
    560,
    560,
    100,
    'domain/',
    'entities and rules: Conversation, Participant,\nMessage, digest policies',
    { fill: INK, stroke: INK, titleColor: GROUND },
  )
  d.arrow('a-main-i', 'main', 'interfaces', { dashed: true })
  d.arrow('a-main-n', 'main', 'infra', { dashed: true })
  d.arrow('a-i-app', 'interfaces', 'app')
  d.arrow('a-n-app', 'infra', 'app')
  d.arrow('a-app-dom', 'app', 'domain')
  d.text(260, 120, 'creates', { size: 14, color: MUTE })
  d.text(200, 335, 'call the use cases', { size: 14, color: MUTE })
  d.text(800, 340, 'implement the ports', { size: 14, color: MUTE })
  d.text(520, 520, 'use', { size: 14, color: MUTE })
  d.text(
    480,
    676,
    'Dependencies only point inward: domain/ and application/ never import infrastructure/ or interfaces/',
    { size: 14, color: MUTE },
  )
  return d
}

const DIAGRAMS = { overview, privacy, architecture }

// The alternative text of each SVG (screen readers, and Biome's a11y lint, which checks SVG files).
const TITLES = {
  overview:
    'How msum works: WhatsApp feeds the daemon on your machine, which stores messages in SQLite, asks the LLM provider you chose for summaries and delivers the digest to your own chat. The web page and the CLI control the daemon.',
  privacy:
    'What stays on your machine (messages, SQLite, voice notes, session, secrets, digest history, local only chats with your Ollama) and what leaves it (the text of chats not marked local only, to the provider you chose, and the digest, to your own chat).',
  architecture:
    'Ports and adapters: interfaces and infrastructure depend on application, which depends on domain; main wires everything.',
}
const withTitle = (svg, name) =>
  svg.replace(/^<svg /, '<svg role="img" ').replace(/(<svg[^>]*>)/, `$1<title>${TITLES[name]}</title>`)

// Runs inside the browser: bundled with esbuild so it can import Excalidraw.
const ENTRY = `
import { convertToExcalidrawElements, exportToSvg } from '@excalidraw/excalidraw'
window.renderDiagram = async (skeleton, centers) => {
  const elements = convertToExcalidrawElements(skeleton, { regenerateIds: false })
  for (const el of elements) {
    if (el.type === 'text' && centers[el.id] !== undefined) el.x = centers[el.id] - el.width / 2
  }
  // Arrows: the bindings come from the skeleton, the geometry is computed here (center to center, clipped to the
  // edges of the two rectangles), and each rectangle records the arrow in boundElements, as Excalidraw itself does.
  const GAP = 4
  const byId = new Map(elements.map((e) => [e.id, e]))
  const clip = (r, tx, ty) => {
    const cx = r.x + r.width / 2
    const cy = r.y + r.height / 2
    const dx = tx - cx
    const dy = ty - cy
    const s = Math.min((r.width / 2 + GAP) / Math.abs(dx || 1e-9), (r.height / 2 + GAP) / Math.abs(dy || 1e-9))
    return [cx + dx * s, cy + dy * s]
  }
  for (const a of elements) {
    if (a.type !== 'arrow') continue
    const from = byId.get(a.startBinding.elementId)
    const to = byId.get(a.endBinding.elementId)
    const [sx, sy] = clip(from, to.x + to.width / 2, to.y + to.height / 2)
    const [ex, ey] = clip(to, from.x + from.width / 2, from.y + from.height / 2)
    a.x = sx
    a.y = sy
    a.points = [[0, 0], [ex - sx, ey - sy]]
    a.width = Math.abs(ex - sx)
    a.height = Math.abs(ey - sy)
    a.startBinding = { elementId: from.id, focus: 0, gap: GAP }
    a.endBinding = { elementId: to.id, focus: 0, gap: GAP }
    for (const r of [from, to]) r.boundElements = [...(r.boundElements ?? []), { id: a.id, type: 'arrow' }]
  }
  const appState = { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false }
  const svg = await exportToSvg({ elements, appState, files: null, exportPadding: 24, skipInliningFonts: true })
  return {
    elements,
    appState: { viewBackgroundColor: '#ffffff', gridSize: null },
    svg: new XMLSerializer().serializeToString(svg),
  }
}
`

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'msum-diagrams-'))
  writeFileSync(join(work, 'entry.js'), ENTRY)
  const bundle = await esbuild.build({
    entryPoints: [join(work, 'entry.js')],
    bundle: true,
    write: false,
    format: 'iife',
    nodePaths: [join(resolve(tools), 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"' },
    loader: { '.woff2': 'dataurl' },
    logLevel: 'error',
  })
  const script = bundle.outputFiles[0].text
  await mkdir(outDir, { recursive: true })
  const names = process.argv.slice(2)
  const wanted = names.length > 0 ? names : Object.keys(DIAGRAMS)

  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    const page = await browser.newPage()
    await page.setContent('<!doctype html><html><body></body></html>')
    await page.addScriptTag({ content: script })
    for (const name of wanted) {
      const make = DIAGRAMS[name]
      if (!make) throw new Error(`Unknown diagram: ${name}`)
      const { elements, centers } = make()
      const result = await page.evaluate(([s, c]) => window.renderDiagram(s, c), [elements, centers])
      const source = {
        type: 'excalidraw',
        version: 2,
        source: 'docs/images/generate-diagrams.mjs',
        elements: result.elements,
        appState: result.appState,
        files: {},
      }
      await writeFile(join(outDir, `${name}.excalidraw`), `${JSON.stringify(source, null, 2)}\n`)
      await writeFile(join(outDir, `${name}.svg`), `${withTitle(result.svg, name)}\n`)
      console.log(`wrote ${name}.excalidraw and ${name}.svg`)
    }
  } finally {
    await browser.close()
  }
}

await main()

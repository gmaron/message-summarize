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

/**
 * The builder plus the pieces of a flow chart: nodes (steps, pills, decisions, notes), arrows with a label and
 * `chain`, which stacks nodes top to bottom and joins them. Every arrow is axis-aligned (nodes that are joined
 * share a center line), so a straight arrow is always clean.
 */
function flowKit() {
  const d = builder()
  const geo = {}
  const LH = 1.15 // line height of Helvetica in Excalidraw
  const lines = (s) => (s ? s.split('\n').length : 0)
  const STYLES = {
    step: { fill: GROUND, stroke: LINE, color: INK, detailColor: MUTE },
    pill: { fill: INK, stroke: INK, color: GROUND, detailColor: LINE, pill: true },
    good: { fill: GROUND, stroke: OK, color: INK, detailColor: MUTE },
    bad: { fill: GROUND, stroke: BAD, color: INK, detailColor: MUTE },
    stop: { fill: GROUND, stroke: INK2, color: INK, detailColor: MUTE },
    decision: { fill: GROUND2, stroke: INK, color: INK, detailColor: MUTE, diamond: true },
    note: { fill: GROUND2, stroke: LINE, color: INK2, detailColor: MUTE, dashed: true, small: true },
  }
  d.node = (id, cx, cy, w, h, title, detail, kind = 'step') => {
    const s = STYLES[kind]
    const group = `g-${id}`
    geo[id] = { cx, cy, w, h }
    d.elements.push({
      type: s.diamond ? 'diamond' : 'rectangle',
      id,
      x: cx - w / 2,
      y: cy - h / 2,
      width: w,
      height: h,
      backgroundColor: s.fill,
      fillStyle: 'solid',
      strokeColor: s.stroke,
      strokeWidth: kind === 'decision' ? 1.5 : 1,
      strokeStyle: s.dashed ? 'dashed' : 'solid',
      roughness: 0,
      ...(s.diamond ? {} : { roundness: { type: 3, ...(s.pill ? { value: h / 2 } : {}) } }),
      groupIds: [group],
    })
    const tSize = s.small ? 14 : 17
    const dSize = 14
    const tH = lines(title) * tSize * LH
    const dH = detail ? 6 + lines(detail) * dSize * LH : 0
    const top = cy - (tH + dH) / 2
    d.text(cx, top, title, { size: tSize, color: s.color, group })
    if (detail) d.text(cx, top + tH + 6, detail, { size: dSize, color: s.detailColor, group })
  }
  /** An arrow between two nodes, with an optional label beside it. */
  d.link = (id, from, to, { label, dashed = false, color = INK2, labelColor = INK2 } = {}) => {
    d.arrow(id, from, to, { dashed, color })
    if (!label) return
    const a = geo[from]
    const b = geo[to]
    const vertical = Math.abs(b.cy - a.cy) >= Math.abs(b.cx - a.cx)
    const n = lines(label)
    const widest = Math.max(...label.split('\n').map((l) => l.length))
    if (vertical) {
      const sign = b.cy > a.cy ? 1 : -1
      const mid = (a.cy + sign * (a.h / 2) + (b.cy - sign * (b.h / 2))) / 2
      d.text(a.cx + 12 + widest * 3.6, mid - (n * 14 * LH) / 2, label, { size: 14, color: labelColor })
    } else {
      const sign = b.cx > a.cx ? 1 : -1
      const mid = (a.cx + sign * (a.w / 2) + (b.cx - sign * (b.w / 2))) / 2
      d.text(mid, a.cy - 8 - n * 14 * LH, label, { size: 14, color: labelColor })
    }
  }
  /**
   * Stacks nodes from y0 down, `gap` apart, and joins each to the next. An item is
   * `{ id, title, detail, kind, h, label }`; its `label` goes on the arrow that arrives at it.
   * Returns the y of each item's center.
   */
  d.chain = (cx, y0, items, { w = 320, gap = 46 } = {}) => {
    const ys = {}
    let y = y0
    items.forEach((it, i) => {
      const kind = it.kind ?? 'step'
      const h = it.h ?? (kind === 'decision' ? 124 : kind === 'pill' ? 56 : 68)
      const width = it.w ?? (kind === 'decision' ? w - 20 : w)
      ys[it.id] = y + h / 2
      d.node(it.id, cx, y + h / 2, width, h, it.title, it.detail, kind)
      if (i > 0) d.link(`a-${items[i - 1].id}-${it.id}`, items[i - 1].id, it.id, { label: it.label })
      y += h + gap
    })
    return ys
  }
  return d
}

// The flow charts of the "how it works" guide. Each takes a language ('es' or 'en') and is written twice from the
// same layout: `t(es, en)` picks the text. Spanish files are `flujo-*`, English files are `flow-*`.
const text = (lang) => (es, en) => (lang === 'en' ? en : es)

function flowGeneral(lang) {
  const t = text(lang)
  const d = flowKit()
  const steps = [
    ['m1', t('Te llegan mensajes', 'Messages reach you'), t('a WhatsApp, durante todo el día', 'on WhatsApp, all day')],
    ['m2', t('La app los guarda', 'The app saves them'), t('solo en tu computadora', 'only on your computer')],
    [
      'm3',
      t('Una IA los resume', 'An AI summarizes them'),
      t('en los horarios que elegís', 'on the schedule you choose'),
    ],
    ['m4', t('Recibís la nota', 'You get the note'), t('en tu propio chat', 'in your own chat')],
  ]
  steps.forEach(([id, title, detail], i) => {
    d.node(id, 150 + i * 330, 60, 250, 92, title, detail, i === 3 ? 'pill' : 'step')
    if (i > 0) d.link(`a${i}`, steps[i - 1][0], id)
  })
  d.text(645, 150, t('Lo que la app nunca hace', 'What the app never does'), { size: 17, color: INK2 })
  const never = [
    t('No contesta por vos', 'Never replies for you'),
    t('No le escribe a nadie más', 'Never writes to anyone else'),
    t('No te marca "en línea"', 'Never marks you "online"'),
    t('No manda datos de uso', 'Never sends usage data'),
  ]
  never.forEach((title, i) => {
    d.node(`n${i}`, 150 + i * 330, 230, 280, 56, title, undefined, 'stop')
  })
  return d
}

function flowFirstUse(lang) {
  const t = text(lang)
  const d = flowKit()
  const y = d.chain(
    240,
    10,
    [
      { id: 'p1', title: t('Instalás el programa', 'You install the program'), kind: 'pill' },
      {
        id: 'p2',
        title: t('Se abre la página de control', 'The control page opens'),
        detail: t('Empieza un asistente de 3 pasos', 'A 3-step wizard starts'),
      },
      {
        id: 'p3',
        title: t('Paso 1: Vos', 'Step 1: You'),
        detail: t('Tu nombre y el nombre de la cuenta', 'Your name and the account name'),
      },
      {
        id: 'p4',
        title: t('Paso 2: Resumen', 'Step 2: Summary'),
        detail: t('Elegís la IA y probás la conexión', 'Pick the AI and test the connection'),
      },
      {
        id: 'p5',
        title: t('Paso 3: Vincular', 'Step 3: Link'),
        detail: t('Escaneás el código QR con el celular', 'Scan the QR code with your phone'),
      },
      {
        id: 'p6',
        title: t('Se descarga el historial reciente', 'Recent history is downloaded'),
        detail: t('Se ve una barra de progreso', 'A progress bar shows it'),
      },
      {
        id: 'p7',
        title: t('Se crean dos horarios', 'Two schedules are created'),
        detail: t('9:00 y 18:00, todos los días', '9:00 and 18:00, every day'),
      },
      {
        id: 'p8',
        title: t(
          'Listo: el primer resumen\nllega en el próximo horario',
          'Done: the first summary\narrives at the next time',
        ),
        kind: 'pill',
        h: 64,
      },
    ],
    { w: 340 },
  )
  d.node(
    'n2',
    690,
    y.p2,
    300,
    64,
    t('Podés cerrarlo a mitad\ny retomarlo donde quedó', 'You can close it halfway\nand pick it up where you left off'),
    undefined,
    'note',
  )
  d.node(
    'n4',
    690,
    y.p4,
    300,
    104,
    t(
      'Antes de elegir la IA ves:\ncuánto cuesta, si tus chats salen\nde tu computadora, hacia quién\nvan y qué hace con ellos.\n"Probar conexión" usa un chat inventado',
      'Before choosing the AI you see:\nwhat it costs, whether your chats\nleave your computer, to whom they\ngo and what it does with them.\n"Test connection" uses an invented chat',
    ),
    undefined,
    'note',
  )
  d.node(
    'n5',
    690,
    y.p5,
    300,
    76,
    t(
      'En el celular: WhatsApp,\nAjustes, Dispositivos vinculados.\nSi el QR vence, se renueva solo',
      'On your phone: WhatsApp,\nSettings, Linked devices.\nIf the QR expires, it renews itself',
    ),
    undefined,
    'note',
  )
  d.link('l2', 'p2', 'n2', { dashed: true })
  d.link('l4', 'p4', 'n4', { dashed: true })
  d.link('l5', 'p5', 'n5', { dashed: true })
  return d
}

function flowMessage(lang) {
  const t = text(lang)
  const d = flowKit()
  const y = d.chain(240, 10, [
    { id: 'm1', title: t('Llega un mensaje\na tu WhatsApp', 'A message reaches\nyour WhatsApp'), kind: 'pill', h: 64 },
    { id: 'm2', title: t('¿El chat está excluido?', 'Is the chat excluded?'), kind: 'decision' },
    { id: 'm3', title: t('Se guarda en tu computadora', 'Saved on your computer'), label: 'No' },
    {
      id: 'm4',
      title: t('Se identifica quién lo mandó', 'The sender is identified'),
      detail: t(
        'Nombre de tu agenda; si no hay,\nnombre público y número',
        'Name from your contacts; if none,\npublic name and number',
      ),
      h: 76,
    },
    {
      id: 'm5',
      title: t('Se actualizan los no leídos', 'Unread counts are updated'),
      detail: t('Igual que en tu celular', 'Same as on your phone'),
    },
    { id: 'm6', title: t('Queda listo para el\npróximo resumen', 'Ready for the\nnext summary'), kind: 'pill', h: 64 },
  ])
  d.node(
    'm2x',
    690,
    y.m2,
    300,
    70,
    t('Se descarta', 'Discarded'),
    t('No se guarda ni se resume', 'Not saved, not summarized'),
    'stop',
  )
  d.link('lx', 'm2', 'm2x', { label: t('Sí', 'Yes') })
  d.node(
    'n3',
    690,
    y.m3,
    340,
    120,
    t(
      'Cómo se guarda cada tipo:\ntexto: tal cual\nfoto, video, documento: una\ndescripción, como "[imagen]"\nnota de voz: "[audio]" o su transcripción',
      'How each type is saved:\ntext: as is\nphoto, video, document: a\ndescription, like "[image]"\nvoice note: "[audio]" or its transcript',
    ),
    undefined,
    'note',
  )
  d.link('l3', 'm3', 'n3', { dashed: true })
  return d
}

function flowDigest(lang) {
  const t = text(lang)
  const d = flowKit()
  const y = d.chain(
    240,
    10,
    [
      {
        id: 'r1',
        title: t('Llega un horario o\ntocás "Resumir ahora"', 'A scheduled time arrives or\nyou tap "Summarize now"'),
        kind: 'pill',
        h: 64,
      },
      {
        id: 'r2',
        title: t('Se define el período', 'The period is set'),
        detail: t('Desde donde terminó el resumen anterior', 'From where the last summary ended'),
      },
      {
        id: 'r3',
        title: t('Se juntan los mensajes', 'Messages are gathered'),
        detail: t('de cada conversación del período', 'from each conversation in the period'),
      },
      {
        id: 'r4',
        title: t('Se descartan los que no aportan', 'Noise is discarded'),
        detail: t(
          'Cadenas tuyas enviadas a 3 chats o más;\navisos repetidos en varios grupos',
          'Your own text sent to 3 or more chats;\nthe same notice in several groups',
        ),
        h: 80,
      },
      {
        id: 'r5',
        title: t('La IA resume cada conversación', 'The AI summarizes each conversation'),
        detail: t(
          'Resumen, pendientes, si necesita\nrespuesta y prioridad',
          'Summary, pending items, whether it\nneeds a reply, and priority',
        ),
        h: 80,
      },
      {
        id: 'r6',
        title: t('Se ordena en secciones', 'Sorted into sections'),
        detail: t(
          'Sin agendar, necesitan respuesta,\ncon pendientes, el resto',
          'Not in contacts, need a reply,\nwith pending items, the rest',
        ),
        h: 80,
      },
      { id: 'r7', title: t('¿La cuenta está conectada?', 'Is the account connected?'), kind: 'decision' },
      {
        id: 'r8',
        title: t('Llega a tu chat\n"Mensaje a mí mismo"', 'Delivered to your chat\n"Message yourself"'),
        kind: 'pill',
        h: 64,
        label: t('Sí', 'Yes'),
      },
    ],
    { w: 360 },
  )
  d.node(
    'n2',
    720,
    y.r2,
    300,
    92,
    t(
      'El marcador solo avanza. La vista\nprevia muestra el resultado sin\nenviarlo ni mover el marcador',
      'The marker only moves forward. The\npreview shows the result without\nsending it or moving the marker',
    ),
    undefined,
    'note',
  )
  d.node(
    'n5',
    720,
    y.r5,
    300,
    92,
    t(
      'Si la IA falla con un chat: reintenta\ny usa la IA de respaldo. Si no se\npuede, el resumen avisa cuál faltó',
      'If the AI fails on a chat: it retries\nand uses the backup AI. If that fails,\nthe summary says which one is missing',
    ),
    undefined,
    'note',
  )
  d.node(
    'r7x',
    720,
    y.r7,
    300,
    80,
    t('Queda en una cola', 'Waits in a queue'),
    t(
      'Se envía al reconectar, incluso\nsi reiniciás la computadora',
      'Sent on reconnect, even if you\nrestart the computer',
    ),
    'stop',
  )
  d.link('l2', 'r2', 'n2', { dashed: true })
  d.link('l5', 'r5', 'n5', { dashed: true })
  d.link('l7', 'r7', 'r7x', { label: 'No' })
  return d
}

function flowPrivacy(lang) {
  const t = text(lang)
  const yes = t('Sí', 'Yes')
  const d = flowKit()
  d.node('q0', 220, 40, 300, 56, t('Una conversación con mensajes', 'A conversation with messages'), undefined, 'pill')
  d.node(
    'q1',
    220,
    180,
    280,
    124,
    t('¿La conversación\nestá excluida?', 'Is the conversation\nexcluded?'),
    undefined,
    'decision',
  )
  d.node(
    'q2',
    220,
    380,
    280,
    124,
    t('¿Está marcada\n"solo local"?', 'Is it marked\n"local only"?'),
    undefined,
    'decision',
  )
  d.node(
    'q3',
    600,
    380,
    280,
    124,
    t('¿Hay una IA\nlocal disponible?', 'Is a local AI\navailable?'),
    undefined,
    'decision',
  )
  d.node(
    'x1',
    600,
    180,
    300,
    76,
    t('No se guarda ni se resume', 'Not saved, not summarized'),
    t('Y se borra lo que ya estaba guardado', 'And what was already stored is deleted'),
    'stop',
  )
  d.node(
    'x2',
    980,
    380,
    300,
    84,
    t('Se resume en tu máquina', 'Summarized on your machine'),
    t('Con Ollama: el texto no sale\nde tu computadora', 'With Ollama: the text does not\nleave your computer'),
    'good',
  )
  d.node(
    'x3',
    600,
    570,
    300,
    76,
    t('Se omite y se avisa', 'Skipped, and you are told'),
    t('Nunca va a una IA externa', 'Never goes to an external AI'),
    'stop',
  )
  d.node(
    'x4',
    220,
    570,
    300,
    92,
    t('Se resume con la IA que elegiste', 'Summarized by your chosen AI'),
    t(
      'El texto viaja a ese proveedor,\ncon tu aceptación previa',
      'The text goes to that provider,\nwith your prior consent',
    ),
    'bad',
  )
  d.link('k0', 'q0', 'q1')
  d.link('k1', 'q1', 'x1', { label: yes })
  d.link('k2', 'q1', 'q2', { label: 'No' })
  d.link('k3', 'q2', 'q3', { label: yes })
  d.link('k4', 'q2', 'x4', { label: 'No' })
  d.link('k5', 'q3', 'x2', { label: yes })
  d.link('k6', 'q3', 'x3', { label: 'No' })
  d.text(
    600,
    660,
    t(
      'Borde verde: no sale de tu computadora. Borde rojo: sale hacia el proveedor.',
      'Green border: does not leave your computer. Red border: goes to the provider.',
    ),
    { size: 14, color: MUTE },
  )
  return d
}

function flowSession(lang) {
  const t = text(lang)
  const d = flowKit()
  const y = d.chain(
    530,
    10,
    [
      {
        id: 's1',
        title: t(
          'WhatsApp cierra, rechaza o\nreemplaza la sesión',
          'WhatsApp closes, rejects or\nreplaces the session',
        ),
        kind: 'pill',
        h: 64,
      },
      {
        id: 's2',
        title: t('La app deja de reconectar esa cuenta', 'The app stops reconnecting'),
        detail: t(
          'A propósito: reintentar sin parar\npodría hacer que bloqueen tu número',
          'On purpose: retrying nonstop\ncould get your number banned',
        ),
        h: 80,
      },
      {
        id: 's3',
        title: t('La página muestra el estado y el motivo', 'The page shows the status\nand the reason'),
      },
      { id: 's4', title: t('¿Qué pasó?', 'What happened?'), kind: 'decision', w: 220 },
    ],
    { w: 340 },
  )
  d.node(
    'sl',
    130,
    y.s4,
    260,
    92,
    t('Reintentar', 'Retry'),
    t(
      'Desde la página de control.\nTras un rechazo hay que\nesperar 30 minutos',
      'From the control page.\nAfter a rejection you must\nwait 30 minutes',
    ),
    'step',
  )
  d.node(
    'sr',
    930,
    y.s4,
    260,
    92,
    t('Volver a vincular', 'Link again'),
    t('Desde la página de control,\nescaneando el QR otra vez', 'From the control page,\nscanning the QR again'),
    'step',
  )
  d.node(
    'sn',
    530,
    y.s4 + 190,
    340,
    64,
    t(
      'Las otras cuentas de la instalación\nsiguen funcionando con normalidad',
      'The other accounts in the installation\nkeep working normally',
    ),
    undefined,
    'note',
  )
  d.link('kl', 's4', 'sl', { label: t('Conexión rechazada\no reemplazada', 'Connection rejected\nor replaced') })
  d.link('kr', 's4', 'sr', { label: t('Sesión cerrada\no inválida', 'Session closed\nor invalid') })
  d.link('kn', 's4', 'sn', { dashed: true })
  return d
}

const FLOWS = {
  general: flowGeneral,
  'first-use': flowFirstUse,
  message: flowMessage,
  digest: flowDigest,
  privacy: flowPrivacy,
  session: flowSession,
}
// File names: Spanish `flujo-<es>`, English `flow-<en>`.
const FLOW_NAMES = {
  general: ['flujo-general', 'flow-general'],
  'first-use': ['flujo-primer-uso', 'flow-first-use'],
  message: ['flujo-mensaje', 'flow-message'],
  digest: ['flujo-resumen', 'flow-digest'],
  privacy: ['flujo-privacidad', 'flow-privacy'],
  session: ['flujo-sesion', 'flow-session'],
}

const DIAGRAMS = { overview, privacy, architecture }
for (const [key, make] of Object.entries(FLOWS)) {
  DIAGRAMS[FLOW_NAMES[key][0]] = () => make('es')
  DIAGRAMS[FLOW_NAMES[key][1]] = () => make('en')
}

// The alternative text of each SVG (screen readers, and Biome's a11y lint, which checks SVG files).
const TITLES = {
  overview:
    'How msum works: WhatsApp feeds the daemon on your machine, which stores messages in SQLite, asks the LLM provider you chose for summaries and delivers the digest to your own chat. The web page and the CLI control the daemon.',
  privacy:
    'What stays on your machine (messages, SQLite, voice notes, session, secrets, digest history, local only chats with your Ollama) and what leaves it (the text of chats not marked local only, to the provider you chose, and the digest, to your own chat).',
  architecture:
    'Ports and adapters: interfaces and infrastructure depend on application, which depends on domain; main wires everything.',
  'flujo-general':
    'Recorrido general: te llegan mensajes, la app los guarda en tu computadora, una IA los resume en tus horarios y recibís la nota en tu propio chat. La app nunca contesta por vos, no le escribe a nadie más, no te marca en línea y no manda datos de uso.',
  'flujo-primer-uso':
    'Primer uso: instalar, asistente de tres pasos (Vos, Resumen, Vincular), descarga del historial, creación de los horarios de las 9:00 y las 18:00 y primer resumen.',
  'flujo-mensaje':
    'Qué pasa con cada mensaje que llega: si el chat está excluido se descarta; si no, se guarda en tu computadora, se identifica quién lo mandó y se actualizan los no leídos.',
  'flujo-resumen':
    'Cómo se arma un resumen: se define el período, se juntan los mensajes, se descartan los que no aportan, la IA resume cada conversación, se ordena en secciones y se envía a tu chat, o queda en cola si la cuenta está desconectada.',
  'flujo-privacidad':
    'Adónde va cada conversación: una excluida no se guarda ni se resume; una marcada como solo local se resume en tu máquina o se omite; el resto se resume con la IA que elegiste.',
  'flujo-sesion':
    'Qué pasa cuando WhatsApp corta la sesión: la app deja de reconectar esa cuenta a propósito, la página muestra el motivo y vos elegís reintentar o volver a vincular con el código QR.',
  'flow-general':
    'General flow: messages reach you, the app saves them on your computer, an AI summarizes them on your schedule and you get the note in your own chat. The app never replies for you, never writes to anyone else, never marks you online and never sends usage data.',
  'flow-first-use':
    'First use: install, a three-step wizard (You, Summary, Link), download of the recent history, creation of the 9:00 and 18:00 schedules and the first summary.',
  'flow-message':
    'What happens to each incoming message: if the chat is excluded it is discarded; otherwise it is saved on your computer, the sender is identified and the unread counts are updated.',
  'flow-digest':
    'How a summary is built: the period is set, messages are gathered, noise is discarded, the AI summarizes each conversation, the result is sorted into sections and delivered to your chat, or queued if the account is disconnected.',
  'flow-privacy':
    'Where each conversation goes: an excluded one is not saved or summarized; one marked local only is summarized on your machine or skipped; the rest is summarized by the AI you chose.',
  'flow-session':
    'What happens when WhatsApp cuts the session: the app stops reconnecting that account on purpose, the page shows the reason and you choose to retry or link again with the QR code.',
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

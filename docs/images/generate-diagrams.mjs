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

function flujoGeneral() {
  const d = flowKit()
  const steps = [
    ['m1', 'Te llegan mensajes', 'a WhatsApp, durante todo el día'],
    ['m2', 'La app los guarda', 'solo en tu computadora'],
    ['m3', 'Una IA los resume', 'en los horarios que elegís'],
    ['m4', 'Recibís la nota', 'en tu propio chat'],
  ]
  steps.forEach(([id, title, detail], i) => {
    d.node(id, 150 + i * 330, 60, 250, 92, title, detail, i === 3 ? 'pill' : 'step')
    if (i > 0) d.link(`a${i}`, steps[i - 1][0], id)
  })
  d.text(645, 150, 'Lo que la app nunca hace', { size: 17, color: INK2 })
  const never = ['No contesta por vos', 'No le escribe a nadie más', 'No te marca "en línea"', 'No manda datos de uso']
  never.forEach((t, i) => {
    d.node(`n${i}`, 150 + i * 330, 230, 250, 56, t, undefined, 'stop')
  })
  return d
}

function flujoPrimerUso() {
  const d = flowKit()
  const y = d.chain(
    240,
    10,
    [
      { id: 'p1', title: 'Instalás el programa', kind: 'pill' },
      { id: 'p2', title: 'Se abre la página de control', detail: 'Empieza un asistente de 3 pasos' },
      { id: 'p3', title: 'Paso 1: Vos', detail: 'Tu nombre y el nombre de la cuenta' },
      { id: 'p4', title: 'Paso 2: Resumen', detail: 'Elegís la IA y probás la conexión' },
      { id: 'p5', title: 'Paso 3: Vincular', detail: 'Escaneás el código QR con el celular' },
      { id: 'p6', title: 'Se descarga el historial reciente', detail: 'Se ve una barra de progreso' },
      { id: 'p7', title: 'Se crean dos horarios', detail: '9:00 y 18:00, todos los días' },
      { id: 'p8', title: 'Listo: el primer resumen\nllega en el próximo horario', kind: 'pill', h: 64 },
    ],
    { w: 340 },
  )
  d.node('n2', 690, y.p2, 300, 64, 'Podés cerrarlo a mitad\ny retomarlo donde quedó', undefined, 'note')
  d.node(
    'n4',
    690,
    y.p4,
    300,
    104,
    'Antes de elegir la IA ves:\ncuánto cuesta, si tus chats salen\nde tu computadora, hacia quién\nvan y qué hace con ellos.\n"Probar conexión" usa un chat inventado',
    undefined,
    'note',
  )
  d.node(
    'n5',
    690,
    y.p5,
    300,
    76,
    'En el celular: WhatsApp,\nAjustes, Dispositivos vinculados.\nSi el QR vence, se renueva solo',
    undefined,
    'note',
  )
  d.link('l2', 'p2', 'n2', { dashed: true })
  d.link('l4', 'p4', 'n4', { dashed: true })
  d.link('l5', 'p5', 'n5', { dashed: true })
  return d
}

function flujoMensaje() {
  const d = flowKit()
  const y = d.chain(240, 10, [
    { id: 'm1', title: 'Llega un mensaje\na tu WhatsApp', kind: 'pill', h: 64 },
    { id: 'm2', title: '¿El chat está excluido?', kind: 'decision' },
    { id: 'm3', title: 'Se guarda en tu computadora', label: 'No' },
    {
      id: 'm4',
      title: 'Se identifica quién lo mandó',
      detail: 'Nombre de tu agenda; si no hay,\nnombre público y número',
      h: 76,
    },
    { id: 'm5', title: 'Se actualizan los no leídos', detail: 'Igual que en tu celular' },
    { id: 'm6', title: 'Queda listo para el\npróximo resumen', kind: 'pill', h: 64 },
  ])
  d.node('m2x', 690, y.m2, 300, 70, 'Se descarta', 'No se guarda ni se resume', 'stop')
  d.link('lx', 'm2', 'm2x', { label: 'Sí' })
  d.node(
    'n3',
    690,
    y.m3,
    340,
    120,
    'Cómo se guarda cada tipo:\ntexto: tal cual\nfoto, video, documento: una\ndescripción, como "[imagen]"\nnota de voz: "[audio]" o su transcripción',
    undefined,
    'note',
  )
  d.link('l3', 'm3', 'n3', { dashed: true })
  return d
}

function flujoResumen() {
  const d = flowKit()
  const y = d.chain(
    240,
    10,
    [
      { id: 'r1', title: 'Llega un horario o\ntocás "Resumir ahora"', kind: 'pill', h: 64 },
      { id: 'r2', title: 'Se define el período', detail: 'Desde donde terminó el resumen anterior' },
      { id: 'r3', title: 'Se juntan los mensajes', detail: 'de cada conversación del período' },
      {
        id: 'r4',
        title: 'Se descartan los que no aportan',
        detail: 'Cadenas tuyas enviadas a 3 chats o más;\navisos repetidos en varios grupos',
        h: 80,
      },
      {
        id: 'r5',
        title: 'La IA resume cada conversación',
        detail: 'Resumen, pendientes, si necesita\nrespuesta y prioridad',
        h: 80,
      },
      {
        id: 'r6',
        title: 'Se ordena en secciones',
        detail: 'Sin agendar, necesitan respuesta,\ncon pendientes, el resto',
        h: 80,
      },
      { id: 'r7', title: '¿La cuenta está conectada?', kind: 'decision' },
      { id: 'r8', title: 'Llega a tu chat\n"Mensaje a mí mismo"', kind: 'pill', h: 64, label: 'Sí' },
    ],
    { w: 360 },
  )
  d.node(
    'n2',
    720,
    y.r2,
    300,
    92,
    'El marcador solo avanza. La vista\nprevia muestra el resultado sin\nenviarlo ni mover el marcador',
    undefined,
    'note',
  )
  d.node(
    'n5',
    720,
    y.r5,
    300,
    92,
    'Si la IA falla con un chat: reintenta\ny usa la IA de respaldo. Si no se\npuede, el resumen avisa cuál faltó',
    undefined,
    'note',
  )
  d.node(
    'r7x',
    720,
    y.r7,
    300,
    80,
    'Queda en una cola',
    'Se envía al reconectar, incluso\nsi reiniciás la computadora',
    'stop',
  )
  d.link('l2', 'r2', 'n2', { dashed: true })
  d.link('l5', 'r5', 'n5', { dashed: true })
  d.link('l7', 'r7', 'r7x', { label: 'No' })
  return d
}

function flujoPrivacidad() {
  const d = flowKit()
  d.node('q0', 220, 40, 300, 56, 'Una conversación con mensajes', undefined, 'pill')
  d.node('q1', 220, 180, 280, 124, '¿La conversación\nestá excluida?', undefined, 'decision')
  d.node('q2', 220, 380, 280, 124, '¿Está marcada\n"solo local"?', undefined, 'decision')
  d.node('q3', 600, 380, 280, 124, '¿Hay una IA\nlocal disponible?', undefined, 'decision')
  d.node('x1', 600, 180, 300, 76, 'No se guarda ni se resume', 'Y se borra lo que ya estaba guardado', 'stop')
  d.node('x2', 980, 380, 300, 84, 'Se resume en tu máquina', 'Con Ollama: el texto no sale\nde tu computadora', 'good')
  d.node('x3', 600, 570, 300, 76, 'Se omite y se avisa', 'Nunca va a una IA externa', 'stop')
  d.node(
    'x4',
    220,
    570,
    300,
    92,
    'Se resume con la IA que elegiste',
    'El texto viaja a ese proveedor,\ncon tu aceptación previa',
    'bad',
  )
  d.link('k0', 'q0', 'q1')
  d.link('k1', 'q1', 'x1', { label: 'Sí' })
  d.link('k2', 'q1', 'q2', { label: 'No' })
  d.link('k3', 'q2', 'q3', { label: 'Sí' })
  d.link('k4', 'q2', 'x4', { label: 'No' })
  d.link('k5', 'q3', 'x2', { label: 'Sí' })
  d.link('k6', 'q3', 'x3', { label: 'No' })
  d.text(600, 660, 'Borde verde: no sale de tu computadora. Borde rojo: sale hacia el proveedor.', {
    size: 14,
    color: MUTE,
  })
  return d
}

function flujoSesion() {
  const d = flowKit()
  const y = d.chain(
    530,
    10,
    [
      { id: 's1', title: 'WhatsApp cierra, rechaza o\nreemplaza la sesión', kind: 'pill', h: 64 },
      {
        id: 's2',
        title: 'La app deja de reconectar esa cuenta',
        detail: 'A propósito: reintentar sin parar\npodría hacer que bloqueen tu número',
        h: 80,
      },
      { id: 's3', title: 'La página muestra el estado y el motivo' },
      { id: 's4', title: '¿Qué pasó?', kind: 'decision', w: 220 },
    ],
    { w: 340 },
  )
  d.node(
    'sl',
    130,
    y.s4,
    260,
    92,
    'Reintentar',
    'Desde la página de control.\nTras un rechazo hay que\nesperar 30 minutos',
    'step',
  )
  d.node(
    'sr',
    930,
    y.s4,
    260,
    92,
    'Volver a vincular',
    'Desde la página de control,\nescaneando el QR otra vez',
    'step',
  )
  d.node(
    'sn',
    530,
    y.s4 + 190,
    340,
    64,
    'Las otras cuentas de la instalación\nsiguen funcionando con normalidad',
    undefined,
    'note',
  )
  d.link('kl', 's4', 'sl', { label: 'Conexión rechazada\no reemplazada' })
  d.link('kr', 's4', 'sr', { label: 'Sesión cerrada\no inválida' })
  d.link('kn', 's4', 'sn', { dashed: true })
  return d
}

const DIAGRAMS = {
  overview,
  privacy,
  architecture,
  'flujo-general': flujoGeneral,
  'flujo-primer-uso': flujoPrimerUso,
  'flujo-mensaje': flujoMensaje,
  'flujo-resumen': flujoResumen,
  'flujo-privacidad': flujoPrivacidad,
  'flujo-sesion': flujoSesion,
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

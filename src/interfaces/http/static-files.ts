import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The page `/` answers with while the web has not been built. `title` and `message` come from the catalogs. */
export function notBuiltPage(title: string, message: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>
`
}

const within = (root: string, path: string): boolean => path === root || path.startsWith(root + sep)

function send(res: ServerResponse, status: number, type: string, body: string, head: boolean): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) })
  res.end(head ? undefined : body)
}

/**
 * Serves a file of the built web. Nothing outside `root` is ever served: the path is decoded and resolved against the
 * real path of `root`, and the real path of the file (links followed) must be inside it too. `/` is `index.html`. When
 * `root` does not exist `/` answers 503 with `notBuilt` (the build may come later: it is looked at on every request).
 */
export async function serveStatic(
  root: string,
  pathname: string,
  head: boolean,
  res: ServerResponse,
  notBuilt: string,
): Promise<void> {
  const notFound = () => send(res, 404, 'application/json; charset=utf-8', '{"error":"notFound"}', head)
  let rootReal: string
  try {
    rootReal = await realpath(root)
  } catch {
    if (pathname === '/') send(res, 503, 'text/html; charset=utf-8', notBuilt, head)
    else notFound()
    return
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return notFound()
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return notFound()
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const candidate = resolve(rootReal, relative)
  if (!within(rootReal, candidate)) return notFound()
  let file: string
  try {
    file = await realpath(candidate)
    if (!within(rootReal, file) || !(await stat(file)).isFile()) return notFound()
  } catch {
    return notFound()
  }
  const size = (await stat(file)).size
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'no-cache',
  })
  if (head) {
    res.end()
    return
  }
  const stream = createReadStream(file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

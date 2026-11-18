import { closeSync, openSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import QRCode from 'qrcode'
import { FILE_MODE } from './paths.js'

/** The QR as text for the terminal (two rows of the code per line of text). */
export function qrForTerminal(qr: string): Promise<string> {
  return QRCode.toString(qr, { type: 'terminal', small: true })
}

/**
 * Writes the QR as a PNG, readable by the owner only: it is a pairing credential for as long as it is valid, so
 * the caller deletes the file when linking ends. The file exists with mode 0600 before anything is written to it.
 */
export async function writeQrPng(file: string, qr: string): Promise<void> {
  closeSync(openSync(file, 'a', FILE_MODE))
  if (process.platform !== 'win32') await chmod(file, FILE_MODE)
  await QRCode.toFile(file, qr, { type: 'png', width: 400, margin: 2 })
}

/** The QR as an SVG image for the web. Made on every request from the string in memory: nothing is stored. */
export function qrAsSvg(qr: string): Promise<string> {
  return QRCode.toString(qr, { type: 'svg', margin: 2 })
}

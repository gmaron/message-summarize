import { spawn } from 'node:child_process'

/** The command that opens an address in the default browser of each system. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  return { command: 'xdg-open', args: [url] }
}

/**
 * Opens `url` in the default browser, detached: the browser outlives this process. Rejects when it cannot start. The
 * address holds the access token in its fragment: on Linux the browser's command line (visible to the other processes
 * of the same user, for instance in `ps`) can hold it for as long as that browser process runs.
 */
export function openInBrowser(url: string): Promise<void> {
  const { command, args } = browserCommand(url)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

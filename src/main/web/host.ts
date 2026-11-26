import { isIP } from 'node:net'
import { isSetIn, type WebConfig } from '../config/config.js'

/** A host name as DNS writes it (letters, digits, dots, hyphens, at most 253 characters). */
const HOST_NAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/

/** True for what the web may listen on: an IPv4 or IPv6 address (in brackets or not), or a host name. */
export function isValidWebHost(value: string): boolean {
  const host = value.trim()
  if (host === '') return false
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  return isIP(bare) !== 0 || HOST_NAME.test(host)
}

export interface WebHostChoice {
  readonly web: WebConfig
  /** Set when MSUM_WEB_HOST was present but not a valid host: it was ignored and the web keeps its host. */
  readonly invalidEnv: boolean
}

/**
 * Where the web listens. `web.host` in config.json wins when the file sets it. Otherwise MSUM_WEB_HOST (the Docker image
 * sets it to 0.0.0.0: the port Docker publishes can only reach a server that listens on the container's interfaces) wins
 * over the default 127.0.0.1. An invalid value is never used, so a typo cannot expose the web: the host stays the one
 * the configuration gave. The warning about a host outside this machine is unchanged.
 */
export function chooseWebHost(
  web: WebConfig,
  rawConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): WebHostChoice {
  const fromEnv = env.MSUM_WEB_HOST
  if (fromEnv === undefined || fromEnv.trim() === '' || isSetIn(rawConfig, 'web.host')) {
    return { web, invalidEnv: false }
  }
  if (!isValidWebHost(fromEnv)) return { web, invalidEnv: true }
  return { web: { ...web, host: fromEnv.trim() }, invalidEnv: false }
}

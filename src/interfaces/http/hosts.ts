import { isIP } from 'node:net'

const WILDCARDS = new Set(['0.0.0.0', '::', '[::]'])

/** True for the addresses that only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase()
  return name === 'localhost' || name === '::1' || name === '[::1]' || name.startsWith('127.')
}

/** True for "any interface" addresses. */
export const isWildcardHost = (host: string): boolean => WILDCARDS.has(host.trim().toLowerCase())

const bare = (name: string): string => name.replace(/^\[|\]$/g, '')

/** The host part of a `Host` header or of an `Origin`, split from its port; null when it does not parse. */
function splitHost(header: string): { readonly name: string; readonly port: string | undefined } | null {
  const split = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(header.trim().toLowerCase())
  if (split === null) return null
  return { name: split[1] as string, port: split[2] }
}

/** Whether a name is one the installation lists in `web.allowedHosts` (names of a reverse proxy or a private network). */
export function isListedHost(name: string, allowedHosts: readonly string[]): boolean {
  const wanted = bare(name.trim().toLowerCase())
  return allowedHosts.some((listed) => listed.trim().toLowerCase() === wanted)
}

/**
 * Whether a `Host` header (or the host part of an `Origin`) names this server. Against DNS rebinding (a page that makes
 * a name of its own resolve to 127.0.0.1) only names we expect are accepted: the loopback ones with the port in use,
 * and the configured host. When the configured host is a wildcard (the explicit opt-in to listen everywhere) any IP
 * address is accepted too, because a rebinding page needs a DNS name, not an IP.
 *
 * The names in `allowedHosts` (`web.allowedHosts`, empty by default) are the explicit opt-in for a reverse proxy that
 * forwards the name it was reached by (such as a Tailscale name): they are accepted without a port, since the proxy
 * listens on the standard one, or with the port in use. Anything else is refused as before.
 */
export function isAllowedHost(
  header: string | undefined,
  configuredHost: string,
  port: number,
  allowedHosts: readonly string[] = [],
): boolean {
  if (header === undefined || header === '') return false
  const parsed = splitHost(header)
  if (parsed === null) return false
  const { name } = parsed
  if (isListedHost(name, allowedHosts) && (parsed.port === undefined || parsed.port === String(port))) return true
  if (parsed.port !== String(port)) return false
  if (name === '127.0.0.1' || name === 'localhost' || name === '[::1]') return true
  const configured = bare(configuredHost.trim().toLowerCase())
  if (bare(name) === configured && !isWildcardHost(configured)) return true
  return isWildcardHost(configured) && isIP(bare(name)) !== 0
}

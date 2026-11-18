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

/**
 * Whether a `Host` header (or the host part of an `Origin`) names this server. Against DNS rebinding (a page that makes
 * a name of its own resolve to 127.0.0.1) only names we expect are accepted: the loopback ones with the port in use,
 * and the configured host. When the configured host is a wildcard (the explicit opt-in to listen everywhere) any IP
 * address is accepted too, because a rebinding page needs a DNS name, not an IP.
 */
export function isAllowedHost(header: string | undefined, configuredHost: string, port: number): boolean {
  if (header === undefined || header === '') return false
  const split = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(header.trim().toLowerCase())
  if (split === null) return false
  const name = split[1] as string
  if (split[2] !== String(port)) return false
  if (name === '127.0.0.1' || name === 'localhost' || name === '[::1]') return true
  const configured = bare(configuredHost.trim().toLowerCase())
  if (bare(name) === configured && !isWildcardHost(configured)) return true
  return isWildcardHost(configured) && isIP(bare(name)) !== 0
}

import { describe, expect, it } from 'vitest'
import { DEFAULT_WEB } from '../../../src/main/config.js'
import { chooseWebHost, isValidWebHost } from '../../../src/main/web-host.js'

describe('isValidWebHost', () => {
  it.each(['0.0.0.0', '127.0.0.1', '::', '::1', '[::1]', 'localhost', 'box.local', '192.168.1.5'])(
    'accepts %s',
    (host) => {
      expect(isValidWebHost(host)).toBe(true)
    },
  )
  it.each(['', '  ', 'a b', 'http://x', '0.0.0.0:8787', 'bad_host', '-x.com', '1.2.3.4; rm', '[nope]'])(
    'rejects %j',
    (host) => {
      expect(isValidWebHost(host)).toBe(false)
    },
  )
})

describe('chooseWebHost', () => {
  it('keeps the default when MSUM_WEB_HOST is not set', () => {
    expect(chooseWebHost(DEFAULT_WEB, {}, {})).toEqual({ web: DEFAULT_WEB, invalidEnv: false })
    expect(chooseWebHost(DEFAULT_WEB, {}, { MSUM_WEB_HOST: '  ' }).web.host).toBe('127.0.0.1')
  })

  it('MSUM_WEB_HOST wins over the default', () => {
    const chosen = chooseWebHost(DEFAULT_WEB, {}, { MSUM_WEB_HOST: ' 0.0.0.0 ' })
    expect(chosen.web).toEqual({ ...DEFAULT_WEB, host: '0.0.0.0' })
    expect(chosen.invalidEnv).toBe(false)
  })

  it('web.host of config.json wins over MSUM_WEB_HOST, even when it is the default value', () => {
    const configured = { ...DEFAULT_WEB, host: '127.0.0.1' }
    expect(chooseWebHost(configured, { web: { host: '127.0.0.1' } }, { MSUM_WEB_HOST: '0.0.0.0' }).web.host).toBe(
      '127.0.0.1',
    )
    expect(
      chooseWebHost({ ...DEFAULT_WEB, host: '10.0.0.2' }, { web: { host: '10.0.0.2' } }, { MSUM_WEB_HOST: '0.0.0.0' })
        .web.host,
    ).toBe('10.0.0.2')
  })

  it('a web section without host does not stop the variable', () => {
    expect(chooseWebHost(DEFAULT_WEB, { web: { port: 9000 } }, { MSUM_WEB_HOST: '0.0.0.0' }).web.host).toBe('0.0.0.0')
  })

  it('an invalid value is ignored and reported, never used', () => {
    const chosen = chooseWebHost(DEFAULT_WEB, {}, { MSUM_WEB_HOST: 'not a host' })
    expect(chosen).toEqual({ web: DEFAULT_WEB, invalidEnv: true })
  })
})

import childProcess from 'node:child_process'
import dgram from 'node:dgram'
import dns from 'node:dns'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { allowNetwork, allowSubprocess } from '../support/network-guard.js'
import { isWindows } from '../support/platform.js'

const external = (host: string) => `Undeclared network call to ${host}`

describe('network guard (RNF-01)', () => {
  it('rejects fetch to an external host', async () => {
    await expect(fetch('https://example.com/')).rejects.toThrow(external('example.com'))
  })

  it('rejects http.get to an external host', () => {
    expect(() => http.get('http://example.com/')).toThrow(external('example.com'))
  })

  it('rejects a raw socket connect to an external host', () => {
    expect(() => net.connect({ host: 'example.com', port: 80 })).toThrow(external('example.com'))
    expect(() => new net.Socket().connect(80, 'example.org')).toThrow(external('example.org'))
  })

  it('rejects an external IP', () => {
    expect(() => net.connect(80, '203.0.113.7')).toThrow(external('203.0.113.7'))
  })

  it('rejects dns.lookup', async () => {
    expect(() => dns.lookup('example.com', () => {})).toThrow(external('example.com'))
    expect(() => dns.promises.lookup('example.com')).toThrow(external('example.com'))
  })

  it('rejects dns.resolve*, reverse and lookupService', () => {
    expect(() => dns.resolve('example.com', () => {})).toThrow(external('example.com'))
    expect(() => dns.resolve4('example.com', () => {})).toThrow(external('example.com'))
    expect(() => dns.resolveTxt('example.com', () => {})).toThrow(external('example.com'))
    expect(() => dns.reverse('203.0.113.7', () => {})).toThrow(external('203.0.113.7'))
    expect(() => dns.lookupService('203.0.113.7', 80, () => {})).toThrow(external('203.0.113.7'))
    expect(() => dns.promises.resolve('example.com')).toThrow(external('example.com'))
    expect(() => dns.promises.resolveMx('example.com')).toThrow(external('example.com'))
  })

  it('rejects the dns.Resolver classes', () => {
    expect(() => new dns.Resolver().resolve4('example.com', () => {})).toThrow(external('example.com'))
    expect(() => new dns.Resolver().resolveAny('example.com', () => {})).toThrow(external('example.com'))
    expect(() => new dns.promises.Resolver().resolve6('example.com')).toThrow(external('example.com'))
    expect(() => new dns.promises.Resolver().resolveSrv('example.com')).toThrow(external('example.com'))
  })

  it('rejects dgram sockets sending or connecting to an external host', () => {
    const socket = dgram.createSocket('udp4')
    try {
      expect(() => socket.send('hi', 9, '203.0.113.7')).toThrow(external('203.0.113.7'))
      expect(() => socket.send('hi', 0, 2, 9, 'example.com')).toThrow(external('example.com'))
      expect(() => socket.connect(9, 'example.com')).toThrow(external('example.com'))
    } finally {
      socket.close()
    }
  })

  it('lets a localhost server round-trip work', async () => {
    const server = http.createServer((_req, res) => res.end('pong'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('pong')
      expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe('pong')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  describe('allowNetwork', () => {
    let revoke: (() => void) | undefined
    afterEach(() => revoke?.())

    it('permits a declared host until revoked', async () => {
      const server = net.createServer((socket) => socket.on('data', (data) => socket.end(`echo:${data}`)))
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      // the fake lookup keeps the connection on loopback: no real DNS is involved
      const fakeLookup: net.LookupFunction = (_host, options, cb) =>
        options.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)
      const connect = () => net.connect({ host: 'api.example.test', port, lookup: fakeLookup })
      try {
        expect(connect).toThrow(external('api.example.test'))

        revoke = allowNetwork('api.example.test')
        const reply = await new Promise<string>((resolve, reject) => {
          const socket = connect()
          let received = ''
          socket.on('error', reject)
          socket.on('data', (data) => {
            received += data
          })
          socket.on('end', () => resolve(received))
          socket.write('ping')
        })
        expect(reply).toBe('echo:ping')

        revoke()
        expect(connect).toThrow(external('api.example.test'))
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })
  })

  describe('subprocesses', () => {
    let revoke: (() => void) | undefined
    afterEach(() => revoke?.())
    const subprocess = (command: string) => `Undeclared subprocess: ${command}`

    it('rejects every child_process entry point', () => {
      expect(() => childProcess.spawn('curl', ['https://example.com'])).toThrow(subprocess('curl'))
      expect(() => childProcess.spawnSync('curl')).toThrow(subprocess('curl'))
      expect(() => childProcess.exec('curl https://example.com')).toThrow(subprocess('curl https://example.com'))
      expect(() => childProcess.execSync('curl https://example.com')).toThrow(subprocess('curl https://example.com'))
      expect(() => childProcess.execFile('curl')).toThrow(subprocess('curl'))
      expect(() => childProcess.execFileSync('curl')).toThrow(subprocess('curl'))
      expect(() => childProcess.fork('child.js')).toThrow(subprocess('child.js'))
    })

    it('allows only the exact `net use` (what Vite runs), and only on Windows', () => {
      // any other net command, or `net use` with arguments, stays blocked everywhere
      expect(() => childProcess.exec('net view')).toThrow(subprocess('net view'))
      expect(() => childProcess.exec('net use Z: \\\\host\\share')).toThrow(/Undeclared subprocess: net use Z:/)
      expect(() => childProcess.execSync('net user')).toThrow(subprocess('net user'))
      // off Windows not even the exact command goes through (on Windows it would run the real, harmless one)
      if (!isWindows) expect(() => childProcess.exec('net use')).toThrow(subprocess('net use'))
    })

    it('rejects worker_threads Worker', () => {
      expect(() => new Worker('/tmp/no-such-worker.js')).toThrow(subprocess('/tmp/no-such-worker.js'))
    })

    it('permits a declared command until revoked', () => {
      revoke = allowSubprocess(process.execPath)
      const result = childProcess.spawnSync(process.execPath, ['-e', "process.stdout.write('fake')"], {
        encoding: 'utf8',
      })
      expect(result.stdout).toBe('fake')
      revoke()
      expect(() => childProcess.spawnSync(process.execPath, ['-e', ''])).toThrow(subprocess(process.execPath))
    })
  })
})

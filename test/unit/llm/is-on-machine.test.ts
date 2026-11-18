import { describe, expect, it } from 'vitest'
import { isOnMachine } from '../../../src/infrastructure/llm/index.js'

describe('isOnMachine (is the address of Ollama this computer?)', () => {
  it.each([
    'http://localhost:11434',
    'http://LOCALHOST:11434',
    'http://127.0.0.1:11434',
    'http://127.0.0.1',
    'http://127.255.255.254:11434',
    'http://[::1]:11434',
    'http://host.docker.internal:11434',
    'https://localhost/api',
  ])('%s is on this machine', (url) => {
    expect(isOnMachine(url)).toBe(true)
  })

  it.each([
    'http://192.168.1.50:11434',
    'http://10.0.0.5:11434',
    'http://0.0.0.0:11434',
    'http://128.0.0.1:11434',
    'http://127.0.0.1.evil.example:11434',
    'http://localhost.evil.example:11434',
    'http://my-server.lan:11434',
    'http://[::2]:11434',
    'http://172.17.0.1:11434',
    'not a url',
    '',
  ])('%s is not', (url) => {
    expect(isOnMachine(url)).toBe(false)
  })
})

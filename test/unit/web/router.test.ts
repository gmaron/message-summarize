import { describe, expect, it } from 'vitest'
import {
  accountOfRoute,
  type HashTarget,
  hrefOf,
  parseRoute,
  type Route,
  tabOfRoute,
  watchHash,
} from '../../../src/interfaces/web/lib/router.js'

describe('the route of an address', () => {
  it('reads every page', () => {
    expect(parseRoute('#/')).toEqual({ name: 'home' })
    expect(parseRoute('#/agregar-cuenta')).toEqual({ name: 'add' })
    expect(parseRoute('#/logs')).toEqual({ name: 'logs', account: null })
    expect(parseRoute('#/logs?cuenta=personal')).toEqual({ name: 'logs', account: 'personal' })
    expect(parseRoute('#/cuentas/personal')).toEqual({ name: 'account', id: 'personal', tab: 'resumen' })
    expect(parseRoute('#/cuentas/personal/conversaciones')).toEqual({
      name: 'account',
      id: 'personal',
      tab: 'conversaciones',
    })
    expect(parseRoute('#/cuentas/personal/horarios')).toEqual({ name: 'account', id: 'personal', tab: 'horarios' })
    expect(parseRoute('#/cuentas/personal/historial')).toEqual({ name: 'account', id: 'personal', tab: 'historial' })
    expect(parseRoute('#/cuentas/personal/historial/148')).toEqual({ name: 'run', id: 'personal', runId: 148 })
    expect(parseRoute('#/cuentas/personal/ajustes')).toEqual({ name: 'account', id: 'personal', tab: 'ajustes' })
    expect(parseRoute('#/cuentas/personal/ajustes/prompt')).toEqual({ name: 'prompt', id: 'personal' })
    expect(parseRoute('#/cuentas/personal/vista-previa')).toEqual({ name: 'preview', id: 'personal' })
    expect(parseRoute('#/cuentas/personal/vincular')).toEqual({ name: 'link', id: 'personal' })
  })

  it('takes no `#`, a trailing slash or an empty address as the same thing', () => {
    expect(parseRoute('')).toEqual({ name: 'home' })
    expect(parseRoute('#')).toEqual({ name: 'home' })
    expect(parseRoute('/cuentas/personal/')).toEqual({ name: 'account', id: 'personal', tab: 'resumen' })
  })

  it('sends an address nobody knows to the home page', () => {
    for (const hash of [
      '#/nada',
      '#/cuentas',
      '#/cuentas/',
      '#/cuentas/personal/otra-cosa',
      '#/cuentas/personal/historial/abc',
      '#/cuentas/personal/historial/0',
      '#/cuentas/personal/historial/1.5',
      '#/cuentas/personal/ajustes/otra',
      '#/cuentas/personal/historial/1/mas',
      '#/logs/otra',
      '#/cuentas/%E0%A4%A',
    ]) {
      expect(parseRoute(hash), hash).toEqual({ name: 'home' })
    }
  })

  it('decodes the account of the address and ignores an empty `cuenta`', () => {
    expect(parseRoute('#/cuentas/mi%20cuenta')).toEqual({ name: 'account', id: 'mi cuenta', tab: 'resumen' })
    expect(parseRoute('#/logs?cuenta=')).toEqual({ name: 'logs', account: null })
  })
})

describe('the address of a route', () => {
  const routes: Route[] = [
    { name: 'home' },
    { name: 'add' },
    { name: 'logs', account: null },
    { name: 'logs', account: 'club' },
    { name: 'account', id: 'club', tab: 'resumen' },
    { name: 'account', id: 'club', tab: 'horarios' },
    { name: 'run', id: 'club', runId: 7 },
    { name: 'prompt', id: 'club' },
    { name: 'preview', id: 'club' },
    { name: 'link', id: 'club' },
    { name: 'account', id: 'mi cuenta/x', tab: 'ajustes' },
    { name: 'account', id: 'nueva', tab: 'resumen' },
    { name: 'account', id: 'agregar-cuenta', tab: 'resumen' },
  ]

  it('gives back the same route when it is read again', () => {
    for (const route of routes) expect(parseRoute(hrefOf(route)), hrefOf(route)).toEqual(route)
  })

  it('writes readable paths', () => {
    expect(hrefOf({ name: 'account', id: 'club', tab: 'resumen' })).toBe('#/cuentas/club')
    expect(hrefOf({ name: 'run', id: 'club', runId: 7 })).toBe('#/cuentas/club/historial/7')
    expect(hrefOf({ name: 'logs', account: 'club' })).toBe('#/logs?cuenta=club')
  })

  it('says which account and which tab a route belongs to', () => {
    expect(accountOfRoute({ name: 'home' })).toBeNull()
    expect(accountOfRoute({ name: 'logs', account: 'club' })).toBeNull()
    expect(accountOfRoute({ name: 'run', id: 'club', runId: 7 })).toBe('club')
    expect(tabOfRoute({ name: 'run', id: 'club', runId: 7 })).toBe('historial')
    expect(tabOfRoute({ name: 'prompt', id: 'club' })).toBe('ajustes')
    expect(tabOfRoute({ name: 'preview', id: 'club' })).toBe('resumen')
    expect(tabOfRoute({ name: 'account', id: 'club', tab: 'horarios' })).toBe('horarios')
    expect(tabOfRoute({ name: 'home' })).toBeNull()
  })
})

describe('watching the address', () => {
  function fakeWindow(hash: string) {
    const listeners = new Set<() => void>()
    const target: HashTarget & { location: { hash: string } } = {
      location: { hash },
      addEventListener: (_type, listener) => void listeners.add(listener),
      removeEventListener: (_type, listener) => void listeners.delete(listener),
    }
    const go = (next: string) => {
      target.location.hash = next
      for (const listener of [...listeners]) listener()
    }
    return { target, listeners, go }
  }

  it('tells the route now, and each time the address changes (the back button too), until it is stopped', () => {
    const win = fakeWindow('#/cuentas/club/horarios')
    const seen: Route[] = []
    const stop = watchHash(win.target, (route) => seen.push(route))
    win.go('#/logs')
    win.go('#/cuentas/club')
    stop()
    win.go('#/')
    expect(seen).toEqual([
      { name: 'account', id: 'club', tab: 'horarios' },
      { name: 'logs', account: null },
      { name: 'account', id: 'club', tab: 'resumen' },
    ])
    expect(win.listeners.size).toBe(0)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import type { AccountIdentity } from '../../src/application/ports/account-identity.js'
import { SqliteAccountIdentity } from '../../src/infrastructure/persistence/sqlite/account.js'
import { InMemoryAccountIdentity } from '../support/application-fakes.js'
import { TempDatabase } from '../support/persistence-backends.js'

export interface AccountBackend {
  readonly name: string
  create(): { identity: AccountIdentity; close(): void }
}

export const accountBackends: readonly AccountBackend[] = [
  { name: 'in-memory', create: () => ({ identity: new InMemoryAccountIdentity(), close() {} }) },
  {
    name: 'sqlite',
    create: () => {
      const temp = new TempDatabase()
      return { identity: new SqliteAccountIdentity(temp.open()), close: () => temp.dispose() }
    },
  },
]

const A = '5491100000009@s.whatsapp.net'
const B = '5491100000077@s.whatsapp.net'

/** Contract of the AccountIdentity port (src/application/ports/account-identity.ts), for every adapter. */
export function describeAccountIdentityContract(backend: AccountBackend): void {
  describe(`AccountIdentity contract (${backend.name})`, () => {
    const open: { close(): void }[] = []
    const make = (): AccountIdentity => {
      const fixture = backend.create()
      open.push(fixture)
      return fixture.identity
    }
    afterEach(() => {
      for (const fixture of open.splice(0)) fixture.close()
    })

    it('has no account at first', () => {
      expect(make().get()).toBeNull()
    })

    it('binds the first account', () => {
      const identity = make()
      expect(identity.bind(A)).toBe(true)
      expect(identity.get()).toBe(A)
    })

    it('binding the same account again is fine and changes nothing', () => {
      const identity = make()
      identity.bind(A)
      expect(identity.bind(A)).toBe(true)
      expect(identity.get()).toBe(A)
    })

    it('refuses a different account once one is bound, and keeps the first', () => {
      const identity = make()
      identity.bind(A)
      expect(identity.bind(B)).toBe(false)
      expect(identity.get()).toBe(A)
    })

    it('forgets the account on reset, so a different one can be bound', () => {
      const identity = make()
      identity.bind(A)
      identity.reset()
      expect(identity.get()).toBeNull()
      expect(identity.bind(B)).toBe(true)
      expect(identity.get()).toBe(B)
    })

    it('reset with no account bound does nothing', () => {
      const identity = make()
      expect(() => identity.reset()).not.toThrow()
      expect(identity.get()).toBeNull()
    })

    it('refuses an empty id', () => {
      const identity = make()
      expect(() => identity.bind('')).toThrow(RangeError)
      expect(identity.get()).toBeNull()
    })
  })
}

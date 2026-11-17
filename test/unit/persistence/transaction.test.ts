import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { inTransaction } from '../../../src/infrastructure/persistence/sqlite/transaction.js'

const open: DatabaseSync[] = []
const memory = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (x INTEGER PRIMARY KEY)')
  open.push(db)
  return db
}
afterEach(() => {
  for (const db of open.splice(0)) db.close()
})
const count = (db: DatabaseSync): number => (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n

describe('inTransaction', () => {
  it('commits what the work wrote and returns its result', () => {
    const db = memory()
    expect(inTransaction(db, () => db.exec('INSERT INTO t VALUES (1)') ?? 'done')).toBe('done')
    expect(count(db)).toBe(1)
    expect(db.isTransaction).toBe(false)
  })

  it('rolls back when the work throws, and the original error surfaces', () => {
    const db = memory()
    expect(() =>
      inTransaction(db, () => {
        db.exec('INSERT INTO t VALUES (1)')
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(count(db)).toBe(0)
    expect(db.isTransaction).toBe(false)
  })

  it('is re-entrant: a nested call works and commits with the outer one', () => {
    const db = memory()
    inTransaction(db, () => {
      db.exec('INSERT INTO t VALUES (1)')
      inTransaction(db, () => db.exec('INSERT INTO t VALUES (2)'))
    })
    expect(count(db)).toBe(2)
  })

  it('a failing nested call undoes only its own writes when the outer one handles the error', () => {
    const db = memory()
    inTransaction(db, () => {
      db.exec('INSERT INTO t VALUES (1)')
      expect(() =>
        inTransaction(db, () => {
          db.exec('INSERT INTO t VALUES (2)')
          throw new Error('inner')
        }),
      ).toThrow('inner')
    })
    expect((db.prepare('SELECT x FROM t').all() as { x: number }[]).map((r) => r.x)).toEqual([1])
  })

  it('a nested failure that reaches the outer call rolls everything back', () => {
    const db = memory()
    expect(() =>
      inTransaction(db, () => {
        db.exec('INSERT INTO t VALUES (1)')
        inTransaction(db, () => {
          throw new Error('inner')
        })
      }),
    ).toThrow('inner')
    expect(count(db)).toBe(0)
  })

  it('surfaces the original error when SQLite already rolled the transaction back by itself', () => {
    const db = memory()
    expect(() =>
      inTransaction(db, () => {
        db.exec('INSERT INTO t VALUES (1)')
        // ON CONFLICT ROLLBACK ends the transaction inside SQLite, then the statement fails.
        db.exec('INSERT OR ROLLBACK INTO t VALUES (1)')
      }),
    ).toThrow(/UNIQUE|constraint/i)
    expect(db.isTransaction).toBe(false)
    expect(count(db)).toBe(0)
  })

  it('surfaces the original error of a nested call when SQLite already rolled everything back', () => {
    const db = memory()
    expect(() =>
      inTransaction(db, () => {
        db.exec('INSERT INTO t VALUES (1)')
        inTransaction(db, () => db.exec('INSERT OR ROLLBACK INTO t VALUES (1)'))
      }),
    ).toThrow(/UNIQUE|constraint/i)
    expect(db.isTransaction).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { ACCOUNT_ID_MAX_LENGTH, isValidAccountId, normalizeAccountId } from '../../../src/domain/account-id.js'

describe('turning what a person writes into an account id', () => {
  it.each([
    ['Personal', 'personal'],
    ['Mi trabajo', 'mi-trabajo'],
    ['Ñandú', 'nandu'],
    ['Corporativo Ñandú', 'corporativo-nandu'],
    ['  A__B  ', 'a-b'],
    ['Casa  de   campo', 'casa-de-campo'],
    ['--Hola--', 'hola'],
    ['cuenta 2', 'cuenta-2'],
    ['José_María', 'jose-maria'],
    ['Año 2026!', 'ano-2026'],
    ['a.b/c\\d', 'abcd'],
  ])('%j becomes %j', (typed, id) => {
    expect(normalizeAccountId(typed)).toBe(id)
    expect(isValidAccountId(id)).toBe(true)
  })

  it('is empty when nothing valid is left (only symbols, an emoji, blanks)', () => {
    for (const typed of ['', '   ', '🙂', '🙂🙂 !!', '---', '___', '¿?']) expect(normalizeAccountId(typed)).toBe('')
  })

  it('is cut to the longest id, without a hyphen left at the end', () => {
    const long = normalizeAccountId('a'.repeat(50))
    expect(long).toHaveLength(ACCOUNT_ID_MAX_LENGTH)
    const cut = normalizeAccountId(`${'a'.repeat(31)} b`)
    expect(cut).toBe('a'.repeat(31))
    expect(isValidAccountId(cut)).toBe(true)
  })

  it('never gives anything the daemon would refuse: valid or empty', () => {
    for (const typed of ['Mi Trabajo', 'ÑÑÑ', 'x'.repeat(100), '-a-', 'a--b', '9 lives', 'ÀÉÎÕÜ ç']) {
      const id = normalizeAccountId(typed)
      expect(id === '' || isValidAccountId(id), typed).toBe(true)
    }
  })
})

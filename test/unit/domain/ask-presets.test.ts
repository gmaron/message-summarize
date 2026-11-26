import { describe, expect, it } from 'vitest'
import {
  type AskPresetIssue,
  askPresetIssue,
  MAX_ASK_PRESET_NAME_CHARS,
  MAX_ASK_PRESET_TEXT_CHARS,
} from '../../../src/domain/ask-presets.js'

describe('askPresetIssue', () => {
  const ok = { name: 'Orders', text: 'who asked me for something?' }

  it.each<[string, unknown, AskPresetIssue | null]>([
    ['a good preset', ok, null],
    [
      'a name and a text at the limit, with blanks around',
      {
        name: ` ${'n'.repeat(MAX_ASK_PRESET_NAME_CHARS)} `,
        text: ` ${'t'.repeat(MAX_ASK_PRESET_TEXT_CHARS)} `,
      },
      null,
    ],
    ['null', null, 'invalidPreset'],
    ['a string', 'Orders', 'invalidPreset'],
    ['a number', 3, 'invalidPreset'],
    ['a list', [ok], 'invalidPreset'],
    ['an extra key', { ...ok, id: 1 }, 'invalidPreset'],
    ['no name', { text: 'x' }, 'invalidPreset'],
    ['no text', { name: 'x' }, 'invalidPreset'],
    ['a name that is not a string', { ...ok, name: 4 }, 'invalidPreset'],
    ['a text that is not a string', { ...ok, text: 4 }, 'invalidPreset'],
    ['a blank name', { ...ok, name: '  ' }, 'emptyPresetName'],
    ['a name too long', { ...ok, name: 'n'.repeat(MAX_ASK_PRESET_NAME_CHARS + 1) }, 'presetNameTooLong'],
    ['a blank text', { ...ok, text: ' \n ' }, 'emptyPresetText'],
    ['a text too long', { ...ok, text: 't'.repeat(MAX_ASK_PRESET_TEXT_CHARS + 1) }, 'presetTextTooLong'],
  ])('%s', (_name, value, issue) => {
    expect(askPresetIssue(value)).toBe(issue)
  })
})

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  checkArchitecture,
  extractReferenceDirectives,
  extractSpecifiers,
  NON_LITERAL,
} from '../support/architecture.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'fixtures', 'architecture', 'src')
const realSrc = join(here, '..', '..', 'src')

describe('extractReferenceDirectives', () => {
  it('finds types, lib and path directives', () => {
    const source = [
      '/// <reference types="node" />',
      '/// <reference lib="dom" />',
      '/// <reference path="./x.d.ts" />',
      'export const a = 1',
    ].join('\n')
    expect(extractReferenceDirectives(source)).toEqual(['types:node', 'lib:dom', 'path:./x.d.ts'])
  })

  it('ignores a directive-like text that is not a directive', () => {
    expect(extractReferenceDirectives('export const a = \'/// <reference types="node" />\'')).toEqual([])
  })
})

describe('extractSpecifiers', () => {
  it('handles import, import type, export from, side-effect and dynamic imports', () => {
    const source = [
      "import a from './a.js'",
      "import type { B } from './b.js'",
      "export * from './c.js'",
      "export type { D } from './d.js'",
      "import './e.js'",
      "const f = () => import('./f.js')",
      "import {\n  g,\n  h,\n} from './g.js'",
    ].join('\n')
    expect(extractSpecifiers(source).sort()).toEqual(
      ['./a.js', './b.js', './c.js', './d.js', './e.js', './f.js', './g.js'].sort(),
    )
  })

  it('handles require, import = require, import types and template-literal imports', () => {
    const source = [
      "import fs = require('node:fs')",
      "const a = require('lodash')",
      "type T = import('zod').ZodType",
      'const b = () => import(`./b.js`)',
    ].join('\n')
    expect(extractSpecifiers(source).sort()).toEqual(['./b.js', 'lodash', 'node:fs', 'zod'])
  })

  it('reports non-literal arguments', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test, not a template
    expect(extractSpecifiers('const n = "x"\nimport(n)\nimport(`./${n}`)\nrequire(n)')).toEqual([
      NON_LITERAL,
      NON_LITERAL,
      NON_LITERAL,
    ])
  })

  it('is not fooled by comment markers inside strings or by import-like text in strings and regexes', () => {
    const source = [
      "export const url = 'http://x/*'",
      "export const mime = 'audio/*'",
      "export * from '../infrastructure/a.js'",
      'export const text = "import x from \'nowhere\'"',
      'export const re = /import y from "nowhere"|\\/\\*/',
      '/* real comment */',
    ].join('\n')
    expect(extractSpecifiers(source)).toEqual(['../infrastructure/a.js'])
  })

  it('ignores specifiers inside comments', () => {
    expect(extractSpecifiers("// import x from 'a'\n/* import y from 'b' */\nimport z from './z.js'")).toEqual([
      './z.js',
    ])
  })
})

describe('checkArchitecture on fixtures', () => {
  const violations = checkArchitecture(fixtures)
  const byFile = (file: string) => violations.filter((v) => v.file === file).map((v) => v.specifier)

  it('accepts valid imports', () => {
    expect(byFile(join('domain', 'valid.ts'))).toEqual([])
    expect(byFile(join('domain', 'valid-multiline-and-comments.ts'))).toEqual([])
    expect(byFile(join('application', 'valid.ts'))).toEqual([])
  })

  it('rejects domain importing outward', () => {
    expect(byFile(join('domain', 'violates-outward.ts'))).toEqual(['../infrastructure/db.js'])
  })

  it('rejects npm packages and node built-ins in domain', () => {
    expect(byFile(join('domain', 'violates-package.ts'))).toEqual(['zod'])
    expect(byFile(join('domain', 'violates-builtin.ts'))).toEqual(['node:fs'])
  })

  it('rejects re-exports and dynamic imports', () => {
    expect(byFile(join('domain', 'violates-reexport-and-dynamic.ts')).sort()).toEqual(
      ['../application/use-case.js', '../infrastructure/db.js', 'some-package'].sort(),
    )
  })

  it('rejects application importing infrastructure, interfaces or built-ins', () => {
    expect(byFile(join('application', 'violates-infra.ts')).sort()).toEqual(['../infrastructure/db.js', 'node:fs'])
    expect(byFile(join('application', 'violates-interfaces.ts'))).toEqual(['../interfaces/cli.js'])
  })

  it('is not fooled by comment markers inside strings (single, double, template, audio/*)', () => {
    expect(byFile(join('domain', 'violates-comment-in-string.ts'))).toEqual(['../infrastructure/a.js'])
    expect(byFile(join('domain', 'valid-strings-and-regex.ts'))).toEqual([])
  })

  it('rejects template-literal dynamic imports without substitutions like strings', () => {
    expect(byFile(join('domain', 'violates-dynamic-template.ts'))).toEqual(['../infrastructure/db.js'])
  })

  it('rejects import()/require() with a non-literal argument', () => {
    expect(byFile(join('domain', 'violates-non-literal.ts'))).toEqual([NON_LITERAL, NON_LITERAL, NON_LITERAL])
  })

  it('rejects require, import = require and import types', () => {
    expect(byFile(join('domain', 'violates-require.ts')).sort()).toEqual(
      ['../infrastructure/db.js', NON_LITERAL, 'lodash', 'node:fs', 'zod'].sort(),
    )
  })

  it('rejects any non-.ts file in domain and application', () => {
    const files = violations.filter((v) => v.reason.endsWith('only allows .ts files')).map((v) => v.file)
    expect(files.sort()).toEqual(
      [
        join('application', 'violates-extension.cts'),
        join('application', 'violates-extension.mts'),
        join('domain', 'violates-extension.cjs'),
        join('domain', 'violates-extension.js'),
        join('domain', 'violates-extension.mjs'),
      ].sort(),
    )
  })

  it('rejects triple-slash reference directives', () => {
    expect(byFile(join('domain', 'violates-triple-slash.ts')).sort()).toEqual([
      '/// <reference lib:dom>',
      '/// <reference path:./x.d.ts>',
      '/// <reference types:node>',
    ])
    expect(byFile(join('application', 'violates-triple-slash.ts'))).toEqual(['/// <reference types:node>'])
  })

  it('does not constrain other layers', () => {
    expect(byFile(join('infrastructure', 'free.ts'))).toEqual([])
  })
})

describe('real src/ (RNF-14)', () => {
  it('domain and application only depend inward', () => {
    expect(checkArchitecture(realSrc)).toEqual([])
  })
})

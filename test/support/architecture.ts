import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
// A second, older TypeScript installed under an alias only for its stable parser API: the main `typescript`
// package (7.x) has no stable JavaScript API. This is a dev dependency used by tests only.
import ts from 'typescript-5'

// RNF-14: dependencies only point inward.
const ALLOWED_LAYERS: Record<string, readonly string[]> = {
  domain: ['domain'],
  application: ['domain', 'application'],
}

// In domain/ and application/ only TypeScript sources are allowed.
const FORBIDDEN_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.cts', '.mts', '.jsx', '.tsx'])
const SOURCE_EXTENSIONS = new Set(['.ts', ...FORBIDDEN_EXTENSIONS])

/** Placeholder specifier reported for an import()/require() whose argument is not a static string. */
export const NON_LITERAL = '<non-literal>'

export interface Violation {
  file: string
  specifier: string
  reason: string
}

function staticText(node: ts.Node | undefined): string | undefined {
  if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text
  return undefined
}

/**
 * Every module specifier a file loads: import / import type / export from / side-effect imports, `import x =
 * require()`, dynamic import(), require(), and `import('x')` types. A call whose argument is not a static string is
 * reported as NON_LITERAL.
 */
function parse(source: string, fileName: string): ts.SourceFile {
  const kind = /\.(c|m)?jsx?$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, kind)
}

/**
 * Triple-slash directives (`/// <reference types|lib|path />`), reported as `types:node`, `lib:dom`, `path:./x.ts`.
 * They can bring Node or DOM globals back into the core typecheck, so the core layers must not have any.
 */
export function extractReferenceDirectives(source: string, fileName = 'file.ts'): string[] {
  const sourceFile = parse(source, fileName)
  return [
    ...sourceFile.typeReferenceDirectives.map((d) => `types:${d.fileName}`),
    ...sourceFile.libReferenceDirectives.map((d) => `lib:${d.fileName}`),
    ...sourceFile.referencedFiles.map((d) => `path:${d.fileName}`),
  ]
}

export function extractSpecifiers(source: string, fileName = 'file.ts'): string[] {
  const sourceFile = parse(source, fileName)
  const found: string[] = []

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      found.push(staticText(node.moduleSpecifier) ?? NON_LITERAL)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      found.push(staticText(node.moduleReference.expression) ?? NON_LITERAL)
    } else if (ts.isImportTypeNode(node)) {
      found.push(ts.isLiteralTypeNode(node.argument) ? (staticText(node.argument.literal) ?? NON_LITERAL) : NON_LITERAL)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
      if (isDynamicImport || isRequire) found.push(staticText(node.arguments[0]) ?? NON_LITERAL)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listSourceFiles(path))
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path)
  }
  return files
}

function layerOf(srcRoot: string, path: string): string | undefined {
  const rel = relative(srcRoot, path)
  if (rel.startsWith('..')) return undefined
  return rel.split(sep)[0]
}

export function checkFile(srcRoot: string, file: string): Violation[] {
  const layer = layerOf(srcRoot, file)
  const allowed = layer === undefined ? undefined : ALLOWED_LAYERS[layer]
  if (layer === undefined || allowed === undefined) return []

  const violations: Violation[] = []
  const name = relative(srcRoot, file)
  if (FORBIDDEN_EXTENSIONS.has(extname(file))) {
    violations.push({ file: name, specifier: '', reason: `${layer}/ only allows .ts files` })
  }
  const text = readFileSync(file, 'utf8')
  for (const directive of extractReferenceDirectives(text, file)) {
    violations.push({
      file: name,
      specifier: `/// <reference ${directive}>`,
      reason: `${layer}/ must not use triple-slash reference directives`,
    })
  }
  for (const specifier of extractSpecifiers(text, file)) {
    const fail = (reason: string) => violations.push({ file: name, specifier, reason })
    if (specifier === NON_LITERAL) {
      fail(`${layer}/ must not use import()/require() with a non-literal argument`)
    } else if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      fail(
        specifier.startsWith('node:') ? `${layer}/ must not use Node built-ins` : `${layer}/ must not use npm packages`,
      )
    } else {
      const target = layerOf(srcRoot, resolve(dirname(file), specifier))
      if (target === undefined) fail(`${layer}/ must not import from outside src/`)
      else if (!allowed.includes(target)) fail(`${layer}/ must not import from ${target}/`)
    }
  }
  return violations
}

export function checkArchitecture(srcRoot: string): Violation[] {
  const root = resolve(srcRoot)
  return listSourceFiles(root).flatMap((file) => checkFile(root, file))
}

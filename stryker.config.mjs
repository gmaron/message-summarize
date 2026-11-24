// Mutation testing: checks that the tests fail when the code changes.
// Run with `npm run test:mutation`. Scoped to domain/ and application/,
// where AGENTS.md sets the coverage targets.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.config.ts' },
  coverageAnalysis: 'perTest',
  mutate: ['src/domain/**/*.ts', 'src/application/**/*.ts', '!src/application/ports/**'],
  reporters: ['clear-text', 'html', 'json', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  tempDirName: '.stryker-tmp',
  // Stryker rewrites tsconfig with the TypeScript JS API, which TypeScript 7
  // no longer ships. Vitest transpiles on its own, so point it at nothing.
  tsconfigFile: 'stryker-skips-tsconfig.json',
  concurrency: 6,
  timeoutMS: 20000,
}

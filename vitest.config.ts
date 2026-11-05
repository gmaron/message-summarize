import { defineConfig } from 'vitest/config'

// Golden files depend on the author's timezone.
process.env.TZ = 'America/Argentina/Buenos_Aires'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup/network-guard.ts'],
    env: { TZ: 'America/Argentina/Buenos_Aires' },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text'],
      // src/ has no code yet, so the report is empty and the thresholds pass trivially
      reportOnFailure: true, // still print the report when a test fails
      thresholds: {
        'src/domain/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/application/**': { lines: 80, branches: 80, functions: 80, statements: 80 },
      },
    },
  },
})

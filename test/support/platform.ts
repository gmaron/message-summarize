// Platform switches for the tests. POSIX file modes, `chmod`, `getuid` and shebang scripts do not exist (or do not mean
// the same) on Windows, so the tests that check them are skipped there and keep running on Linux and macOS.
export const isWindows = process.platform === 'win32'

// Keeps tsconfig.core.json valid while src/domain and src/application are still empty (TS18003 otherwise).
// That config checks the core with no Node or DOM globals: process, Buffer, fetch, setTimeout and console must not resolve.
export {}

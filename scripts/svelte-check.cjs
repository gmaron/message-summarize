// Runs svelte-check with TypeScript 5.
//
// svelte-check 4 cannot use TypeScript 7 (the project's compiler: it has no JavaScript API yet) and wants a `typescript`
// of version 5 or 6. The project already has TypeScript 5 as `typescript-5`, so while this process runs, requests for
// `typescript` made by svelte-check and its libraries get that one. Nothing else (tsc, the build) is touched.
const Module = require('node:module')
const resolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  const aliased = /^typescript(\/|$)/.test(request) ? request.replace(/^typescript/, 'typescript-5') : request
  return resolve.call(this, aliased, ...rest)
}
process.argv.splice(1, 1, require.resolve('svelte-check/bin/svelte-check'))
require('svelte-check/bin/svelte-check')

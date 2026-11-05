// strings and regular expressions that look like imports or comments
export const mime = 'audio/*'
export const re = /import x from 'y'|\/\*/
export const text = "export * from 'nowhere'"
export const tpl = `import('nowhere')`
export const ok = () => import('./greeting.js')

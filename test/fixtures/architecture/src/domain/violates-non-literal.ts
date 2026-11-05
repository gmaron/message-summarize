const name = '../domain/greeting.js'
export const a = () => import(name)
export const b = () => import(`./${name}`)
export const c = () => import('./' + name)

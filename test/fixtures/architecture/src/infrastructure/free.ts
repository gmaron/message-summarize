import { readFileSync } from 'node:fs'
import { greet } from '../domain/greeting.js'

export const read = () => greet(readFileSync('x', 'utf8'))

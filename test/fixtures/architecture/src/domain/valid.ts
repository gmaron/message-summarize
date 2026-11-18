import type { Participant } from './participant.js'
import { greet } from '../domain/greeting.js'

export type { Participant } from './participant.js'
export const lazy = () => import('./greeting.js')
export const hello = (p: Participant) => greet(p)

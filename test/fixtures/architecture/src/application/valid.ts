import { greet } from '../domain/greeting.js'
import type { Port } from './ports/port.js'

export const run = (port: Port) => greet(port)

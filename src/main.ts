/**
 * OpenAlice composition root.
 *
 * Module assemblers own channels, AI, market data, scheduling, execution,
 * evidence paths, and observability. This file owns only process startup and
 * fatal lifecycle reporting.
 */
import { startOpenAlice } from './bootstrap/application.js'

startOpenAlice().catch((error) => {
  console.error('fatal:', error)
  process.exit(1)
})

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function appendJsonlSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf-8')
}

export function appendRuntimeEventSync(path: string, event: Record<string, unknown>): void {
  appendJsonlSync(path, {
    ts: new Date().toISOString(),
    ...event,
  })
}


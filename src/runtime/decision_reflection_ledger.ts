import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { appendJsonlSync } from './runtime_events.js'

export const DECISION_REFLECTION_LEDGER_SCHEMA_VERSION = 'decision_reflection_ledger.v1'
export const DEFAULT_DECISION_REFLECTION_LEDGER_PATH =
  'data/runtime/decision_reflection_ledger.jsonl'

export const DecisionPendingEventSchema = z.object({
  schemaVersion: z.literal(DECISION_REFLECTION_LEDGER_SCHEMA_VERSION),
  eventType: z.literal('decision.pending'),
  decisionId: z.string().uuid(),
  createdAt: z.string().min(1),
  source: z.string().min(1),
  promptHash: z.string().min(1).optional(),
  summary: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export const DecisionOutcomeEventSchema = z.object({
  schemaVersion: z.literal(DECISION_REFLECTION_LEDGER_SCHEMA_VERSION),
  eventType: z.literal('decision.outcome'),
  decisionId: z.string().uuid(),
  createdAt: z.string().min(1),
  outcome: z.enum(['accepted', 'rejected', 'expired', 'superseded', 'unknown']),
  summary: z.string().min(1),
  metrics: z.record(z.string(), z.unknown()).default({}),
})

export const DecisionReflectionEventSchema = z.object({
  schemaVersion: z.literal(DECISION_REFLECTION_LEDGER_SCHEMA_VERSION),
  eventType: z.literal('decision.reflection'),
  decisionId: z.string().uuid(),
  createdAt: z.string().min(1),
  lesson: z.string().min(1),
  isUseful: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export const DecisionReflectionLedgerEventSchema = z.discriminatedUnion('eventType', [
  DecisionPendingEventSchema,
  DecisionOutcomeEventSchema,
  DecisionReflectionEventSchema,
])

export type DecisionPendingEvent = z.infer<typeof DecisionPendingEventSchema>
export type DecisionOutcomeEvent = z.infer<typeof DecisionOutcomeEventSchema>
export type DecisionReflectionEvent = z.infer<typeof DecisionReflectionEventSchema>
export type DecisionReflectionLedgerEvent = z.infer<typeof DecisionReflectionLedgerEventSchema>

export interface LedgerReadDiagnostic {
  line: number
  message: string
  raw: string
}

export interface LedgerReadResult<TEvent> {
  events: TEvent[]
  diagnostics: LedgerReadDiagnostic[]
}

export interface ReflectionContextOptions {
  maxItems?: number
  maxChars?: number
  now?: Date
}

export function appendDecisionReflectionLedgerEvent(
  event: DecisionReflectionLedgerEvent,
  path = DEFAULT_DECISION_REFLECTION_LEDGER_PATH,
): void {
  appendJsonlSync(path, DecisionReflectionLedgerEventSchema.parse(event))
}

export function readDecisionReflectionLedger(
  path = DEFAULT_DECISION_REFLECTION_LEDGER_PATH,
): LedgerReadResult<DecisionReflectionLedgerEvent> {
  if (!existsSync(path)) {
    return { events: [], diagnostics: [] }
  }

  const events: DecisionReflectionLedgerEvent[] = []
  const diagnostics: LedgerReadDiagnostic[] = []
  const lines = readFileSync(path, 'utf-8').split('\n')
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (!trimmed) {
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed) as unknown
    } catch (error) {
      diagnostics.push({
        line: index + 1,
        message: `Malformed JSON: ${errorMessage(error)}`,
        raw,
      })
      continue
    }

    const event = DecisionReflectionLedgerEventSchema.safeParse(parsed)
    if (!event.success) {
      diagnostics.push({
        line: index + 1,
        message: z.prettifyError(event.error),
        raw,
      })
      continue
    }

    events.push(event.data)
  }

  return { events, diagnostics }
}

export function buildDecisionReflectionContext(
  input: LedgerReadResult<DecisionReflectionLedgerEvent> | DecisionReflectionLedgerEvent[],
  options: ReflectionContextOptions = {},
): string {
  const events = Array.isArray(input) ? input : input.events
  const maxItems = options.maxItems ?? 5
  const maxChars = options.maxChars ?? 2000
  const reflections = events
    .filter((event): event is DecisionReflectionEvent => event.eventType === 'decision.reflection')
    .filter(event => event.isUseful)
    .filter(event => event.lesson.trim().length > 0)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, maxItems)

  const lines: string[] = []
  for (const event of reflections) {
    const tags = event.tags.length > 0 ? ` [${event.tags.join(', ')}]` : ''
    lines.push(`- ${event.createdAt}${tags}: ${event.lesson}`)
  }

  return truncateContext(lines.join('\n'), maxChars)
}

export function createDecisionPendingEvent(input: {
  decisionId: string
  source: string
  summary: string
  createdAt?: Date
  promptHash?: string
  metadata?: Record<string, unknown>
}): DecisionPendingEvent {
  return DecisionPendingEventSchema.parse({
    schemaVersion: DECISION_REFLECTION_LEDGER_SCHEMA_VERSION,
    eventType: 'decision.pending',
    decisionId: input.decisionId,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    source: input.source,
    promptHash: input.promptHash,
    summary: input.summary,
    metadata: input.metadata ?? {},
  })
}

export function createDecisionOutcomeEvent(input: {
  decisionId: string
  outcome: DecisionOutcomeEvent['outcome']
  summary: string
  createdAt?: Date
  metrics?: Record<string, unknown>
}): DecisionOutcomeEvent {
  return DecisionOutcomeEventSchema.parse({
    schemaVersion: DECISION_REFLECTION_LEDGER_SCHEMA_VERSION,
    eventType: 'decision.outcome',
    decisionId: input.decisionId,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    outcome: input.outcome,
    summary: input.summary,
    metrics: input.metrics ?? {},
  })
}

export function createDecisionReflectionEvent(input: {
  decisionId: string
  lesson: string
  createdAt?: Date
  isUseful?: boolean
  tags?: string[]
  metadata?: Record<string, unknown>
}): DecisionReflectionEvent {
  return DecisionReflectionEventSchema.parse({
    schemaVersion: DECISION_REFLECTION_LEDGER_SCHEMA_VERSION,
    eventType: 'decision.reflection',
    decisionId: input.decisionId,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    lesson: input.lesson,
    isUseful: input.isUseful ?? true,
    tags: input.tags ?? [],
    metadata: input.metadata ?? {},
  })
}

function truncateContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }
  return value.slice(0, Math.max(0, maxChars - 3)).trimEnd() + '...'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

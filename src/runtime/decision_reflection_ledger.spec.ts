import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendDecisionReflectionLedgerEvent,
  buildDecisionReflectionContext,
  createDecisionOutcomeEvent,
  createDecisionPendingEvent,
  createDecisionReflectionEvent,
  readDecisionReflectionLedger,
} from './decision_reflection_ledger.js'

const roots: string[] = []
const decisionId = '11111111-1111-4111-8111-111111111111'

function tempLedgerPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openalice-reflection-ledger-'))
  roots.push(root)
  return join(root, 'ledger.jsonl')
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

describe('decision_reflection_ledger', () => {
  it('appends pending, outcome, and reflection events as JSONL', async () => {
    const path = tempLedgerPath()
    appendDecisionReflectionLedgerEvent(createDecisionPendingEvent({
      decisionId,
      createdAt: new Date('2026-05-04T00:00:00.000Z'),
      source: 'market_intel',
      summary: 'Pending market decision',
      metadata: { symbol: 'BTC-USDT' },
    }), path)
    appendDecisionReflectionLedgerEvent(createDecisionOutcomeEvent({
      decisionId,
      createdAt: new Date('2026-05-04T01:00:00.000Z'),
      outcome: 'accepted',
      summary: 'Decision accepted',
      metrics: { pnlPct: 1.2 },
    }), path)
    appendDecisionReflectionLedgerEvent(createDecisionReflectionEvent({
      decisionId,
      createdAt: new Date('2026-05-04T02:00:00.000Z'),
      lesson: 'Avoid acting when data is stale.',
      tags: ['data_quality'],
    }), path)

    const raw = await readFile(path, 'utf-8')
    expect(raw.trim().split('\n')).toHaveLength(3)

    const result = readDecisionReflectionLedger(path)
    expect(result.diagnostics).toEqual([])
    expect(result.events.map(event => event.eventType)).toEqual([
      'decision.pending',
      'decision.outcome',
      'decision.reflection',
    ])
  })

  it('returns diagnostics for malformed JSONL and schema failures without dropping valid events', () => {
    const path = tempLedgerPath()
    const valid = createDecisionReflectionEvent({
      decisionId,
      createdAt: new Date('2026-05-04T02:00:00.000Z'),
      lesson: 'Valid lesson.',
    })
    writeFileSync(
      path,
      [
        JSON.stringify(valid),
        '{"eventType":',
        JSON.stringify({ eventType: 'decision.reflection', decisionId: 'not-a-uuid' }),
        '',
      ].join('\n'),
      'utf-8',
    )

    const result = readDecisionReflectionLedger(path)
    expect(result.events).toHaveLength(1)
    expect(result.diagnostics).toHaveLength(2)
    expect(result.diagnostics[0]).toMatchObject({ line: 2 })
    expect(result.diagnostics[1]).toMatchObject({ line: 3 })
  })

  it('builds bounded context only from useful reflection events', () => {
    const events = [
      createDecisionPendingEvent({
        decisionId,
        createdAt: new Date('2026-05-04T00:00:00.000Z'),
        source: 'market_intel',
        summary: 'Do not include pending.',
      }),
      createDecisionReflectionEvent({
        decisionId,
        createdAt: new Date('2026-05-04T01:00:00.000Z'),
        lesson: 'Older useful lesson.',
        tags: ['older'],
      }),
      createDecisionReflectionEvent({
        decisionId,
        createdAt: new Date('2026-05-04T03:00:00.000Z'),
        lesson: 'Newest useful lesson.',
        tags: ['newer'],
      }),
      createDecisionReflectionEvent({
        decisionId,
        createdAt: new Date('2026-05-04T04:00:00.000Z'),
        lesson: 'Noisy lesson.',
        isUseful: false,
      }),
    ]

    const context = buildDecisionReflectionContext(events, { maxItems: 2, maxChars: 120 })
    expect(context).toContain('Newest useful lesson.')
    expect(context).toContain('Older useful lesson.')
    expect(context).not.toContain('Noisy lesson.')
    expect(context).not.toContain('pending')
    expect(context.indexOf('Newest useful lesson.')).toBeLessThan(
      context.indexOf('Older useful lesson.'),
    )
  })

  it('truncates reflection context at maxChars', () => {
    const context = buildDecisionReflectionContext([
      createDecisionReflectionEvent({
        decisionId,
        createdAt: new Date('2026-05-04T01:00:00.000Z'),
        lesson: 'x'.repeat(200),
      }),
    ], { maxChars: 80 })

    expect(context.length).toBeLessThanOrEqual(80)
    expect(context.endsWith('...')).toBe(true)
  })
})

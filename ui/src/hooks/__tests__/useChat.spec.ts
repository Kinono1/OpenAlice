import { describe, it, expect } from 'vitest'
import { reduceStreamEvent, finalizeMessages } from '../useChat'

// ==================== reduceStreamEvent ====================

describe('reduceStreamEvent', () => {
  it('text event creates a new text segment', () => {
    const result = reduceStreamEvent([], { type: 'text', text: 'hello' })
    expect(result).toEqual([{ kind: 'text', text: 'hello' }])
  })

  it('consecutive text events merge into one segment', () => {
    const s1 = reduceStreamEvent([], { type: 'text', text: 'hel' })
    const s2 = reduceStreamEvent(s1, { type: 'text', text: 'lo' })
    expect(s2).toEqual([{ kind: 'text', text: 'hello' }])
  })

  it('tool_use after text creates a new tools segment', () => {
    const s1 = reduceStreamEvent([], { type: 'text', text: 'thinking...' })
    const s2 = reduceStreamEvent(s1, {
      type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/foo' },
    })
    expect(s2).toHaveLength(2)
    expect(s2[0]).toEqual({ kind: 'text', text: 'thinking...' })
    expect(s2[1]).toEqual({
      kind: 'tools',
      tools: [{ id: 't1', name: 'read_file', input: { path: '/foo' }, status: 'running' }],
    })
  })

  it('consecutive tool_use events merge into one tools segment', () => {
    const s1 = reduceStreamEvent([], {
      type: 'tool_use', id: 't1', name: 'read', input: 'a',
    })
    const s2 = reduceStreamEvent(s1, {
      type: 'tool_use', id: 't2', name: 'write', input: 'b',
    })
    expect(s2).toHaveLength(1)
    expect(s2[0].kind).toBe('tools')
    if (s2[0].kind === 'tools') {
      expect(s2[0].tools).toHaveLength(2)
      expect(s2[0].tools[0].name).toBe('read')
      expect(s2[0].tools[1].name).toBe('write')
    }
  })

  it('text after tools creates a new text segment (边想边做)', () => {
    let segs = reduceStreamEvent([], { type: 'text', text: 'Let me check' })
    segs = reduceStreamEvent(segs, { type: 'tool_use', id: 't1', name: 'search', input: {} })
    segs = reduceStreamEvent(segs, { type: 'text', text: 'Found it' })
    expect(segs).toHaveLength(3)
    expect(segs[0]).toEqual({ kind: 'text', text: 'Let me check' })
    expect(segs[1].kind).toBe('tools')
    expect(segs[2]).toEqual({ kind: 'text', text: 'Found it' })
  })

  it('tool_result marks the correct tool as done', () => {
    let segs = reduceStreamEvent([], { type: 'tool_use', id: 't1', name: 'read', input: '' })
    segs = reduceStreamEvent(segs, { type: 'tool_use', id: 't2', name: 'write', input: '' })
    segs = reduceStreamEvent(segs, { type: 'tool_result', tool_use_id: 't1', content: 'file contents' })
    if (segs[0].kind === 'tools') {
      expect(segs[0].tools[0].status).toBe('done')
      expect(segs[0].tools[0].result).toBe('file contents')
      expect(segs[0].tools[1].status).toBe('running')
    }
  })

  it('tool_result finds tools across multiple segments', () => {
    let segs = reduceStreamEvent([], { type: 'tool_use', id: 't1', name: 'read', input: '' })
    segs = reduceStreamEvent(segs, { type: 'tool_result', tool_use_id: 't1', content: 'ok' })
    segs = reduceStreamEvent(segs, { type: 'text', text: 'now writing' })
    segs = reduceStreamEvent(segs, { type: 'tool_use', id: 't2', name: 'write', input: '' })
    segs = reduceStreamEvent(segs, { type: 'tool_result', tool_use_id: 't2', content: 'written' })

    // t2 is in the second tools segment (index 2)
    expect(segs).toHaveLength(3)
    if (segs[2].kind === 'tools') {
      expect(segs[2].tools[0].status).toBe('done')
      expect(segs[2].tools[0].result).toBe('written')
    }
  })

  it('tool_result for unknown id is a no-op', () => {
    const segs = reduceStreamEvent(
      [{ kind: 'tools', tools: [{ id: 't1', name: 'read', input: '', status: 'running' }] }],
      { type: 'tool_result', tool_use_id: 'unknown', content: 'nope' },
    )
    if (segs[0].kind === 'tools') {
      expect(segs[0].tools[0].status).toBe('running')
      expect(segs[0].tools[0].result).toBeUndefined()
    }
  })

  it('full interleaved sequence produces correct structure', () => {
    const events = [
      { type: 'text' as const, text: 'Let me look into this.' },
      { type: 'tool_use' as const, id: 't1', name: 'search', input: { q: 'bug' } },
      { type: 'tool_result' as const, tool_use_id: 't1', content: 'found 3 results' },
      { type: 'text' as const, text: 'I see the issue. Let me fix it.' },
      { type: 'tool_use' as const, id: 't2', name: 'edit', input: { file: 'a.ts' } },
      { type: 'tool_result' as const, tool_use_id: 't2', content: 'edited' },
    ]

    let segs = reduceStreamEvent([], events[0])
    for (let i = 1; i < events.length; i++) {
      segs = reduceStreamEvent(segs, events[i])
    }

    expect(segs).toHaveLength(4)
    expect(segs[0]).toEqual({ kind: 'text', text: 'Let me look into this.' })
    expect(segs[1].kind).toBe('tools')
    if (segs[1].kind === 'tools') {
      expect(segs[1].tools[0].name).toBe('search')
      expect(segs[1].tools[0].status).toBe('done')
      expect(segs[1].tools[0].result).toBe('found 3 results')
    }
    expect(segs[2]).toEqual({ kind: 'text', text: 'I see the issue. Let me fix it.' })
    expect(segs[3].kind).toBe('tools')
    if (segs[3].kind === 'tools') {
      expect(segs[3].tools[0].name).toBe('edit')
      expect(segs[3].tools[0].status).toBe('done')
    }
  })

  it('does not mutate the input segments array', () => {
    const original = [{ kind: 'text' as const, text: 'hello' }]
    const frozen = [...original]
    const result = reduceStreamEvent(original, { type: 'text', text: ' world' })
    expect(original).toEqual(frozen)
    expect(result).not.toBe(original)
  })
})

// ==================== finalizeMessages ====================

describe('finalizeMessages', () => {
  let idCounter = 0
  const idGen = () => idCounter++

  it('returns empty array when finalText is empty', () => {
    const result = finalizeMessages([], '', undefined, idGen)
    expect(result).toEqual([])
  })

  it('text-only response produces a single assistant message', () => {
    idCounter = 100
    const result = finalizeMessages([], 'Hello!', undefined, idGen)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      kind: 'text', role: 'assistant', text: 'Hello!', media: undefined, _id: 100,
    })
  })

  it('preserves interleaved text → tools order', () => {
    idCounter = 200
    const segments = [
      { kind: 'text' as const, text: 'thinking' },
      {
        kind: 'tools' as const,
        tools: [
          { id: 't1', name: 'read_file', input: '/foo', status: 'done' as const, result: 'contents' },
        ],
      },
    ]
    const result = finalizeMessages(segments, 'Done reading.', undefined, idGen)
    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ kind: 'text', role: 'assistant', text: 'thinking' })
    expect(result[1].kind).toBe('tool_calls')
    if (result[1].kind === 'tool_calls') {
      expect(result[1].calls).toEqual([
        { name: 'read_file', input: '/foo', result: 'contents' },
      ])
    }
    // finalText appended as new text item (last segment was tools, not text)
    expect(result[2]).toMatchObject({ kind: 'text', role: 'assistant', text: 'Done reading.' })
  })

  it('serializes non-string tool input to JSON', () => {
    idCounter = 300
    const segments = [
      {
        kind: 'tools' as const,
        tools: [
          { id: 't1', name: 'search', input: { query: 'bug' }, status: 'done' as const, result: 'ok' },
        ],
      },
    ]
    const result = finalizeMessages(segments, 'Found it.', undefined, idGen)
    // tools segment is first, then finalText appended
    expect(result[0].kind).toBe('tool_calls')
    if (result[0].kind === 'tool_calls') {
      expect(result[0].calls[0].input).toBe('{"query":"bug"}')
    }
  })

  it('passes through media array', () => {
    idCounter = 400
    const media = [{ type: 'image', url: '/img.png' }]
    const result = finalizeMessages([], 'Here is an image.', media, idGen)
    expect(result[0]).toMatchObject({
      kind: 'text', role: 'assistant', media,
    })
  })

  it('preserves interleaved tools → text → tools structure', () => {
    idCounter = 500
    const segments = [
      { kind: 'tools' as const, tools: [{ id: 't1', name: 'a', input: '', status: 'done' as const }] },
      { kind: 'text' as const, text: 'middle' },
      { kind: 'tools' as const, tools: [{ id: 't2', name: 'b', input: '', status: 'done' as const }] },
    ]
    const result = finalizeMessages(segments, 'All done.', undefined, idGen)
    // Each segment becomes its own DisplayItem, plus finalText appended
    expect(result).toHaveLength(4)
    expect(result[0].kind).toBe('tool_calls')
    if (result[0].kind === 'tool_calls') {
      expect(result[0].calls).toHaveLength(1)
      expect(result[0].calls[0].name).toBe('a')
    }
    expect(result[1]).toMatchObject({ kind: 'text', role: 'assistant', text: 'middle' })
    expect(result[2].kind).toBe('tool_calls')
    if (result[2].kind === 'tool_calls') {
      expect(result[2].calls).toHaveLength(1)
      expect(result[2].calls[0].name).toBe('b')
    }
    // finalText replaces nothing (last segment was tools), so appended
    expect(result[3]).toMatchObject({ kind: 'text', role: 'assistant', text: 'All done.' })
  })

  it('replaces last text segment with finalText when last segment is text', () => {
    idCounter = 600
    const segments = [
      { kind: 'tools' as const, tools: [{ id: 't1', name: 'read', input: '', status: 'done' as const }] },
      { kind: 'text' as const, text: 'streaming partial...' },
    ]
    const result = finalizeMessages(segments, 'Complete final text.', undefined, idGen)
    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe('tool_calls')
    // Last text segment replaced with authoritative finalText
    expect(result[1]).toMatchObject({ kind: 'text', role: 'assistant', text: 'Complete final text.' })
  })
})

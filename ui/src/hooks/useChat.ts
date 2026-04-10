import { useState, useEffect, useRef, useCallback } from 'react'
import { chatApi } from '../api/chat'
import type { ChatStreamEvent } from '../api/chat'
import type { ToolCall, StreamingToolCall } from '../api/types'
import { useSSE } from './useSSE'

// ==================== Types ====================

export type DisplayItem =
  | { kind: 'text'; role: 'user' | 'assistant' | 'notification'; text: string; timestamp?: string | null; media?: Array<{ type: string; url: string }>; _id: number }
  | { kind: 'tool_calls'; calls: ToolCall[]; timestamp?: string; _id: number }

export type StreamSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; tools: StreamingToolCall[] }

// ==================== Pure reducers ====================

type StreamEventPayload = Extract<ChatStreamEvent, { type: 'stream' }>['event']

export function reduceStreamEvent(segments: StreamSegment[], ev: StreamEventPayload): StreamSegment[] {
  const next = segments.map((s): StreamSegment =>
    s.kind === 'text' ? { ...s } : { ...s, tools: [...s.tools] },
  )

  if (ev.type === 'tool_use') {
    const last = next[next.length - 1]
    if (last?.kind === 'tools') {
      last.tools.push({ id: ev.id, name: ev.name, input: ev.input, status: 'running' })
    } else {
      next.push({ kind: 'tools', tools: [{ id: ev.id, name: ev.name, input: ev.input, status: 'running' }] })
    }
  } else if (ev.type === 'tool_result') {
    for (const seg of next) {
      if (seg.kind === 'tools') {
        const t = seg.tools.find((tool) => tool.id === ev.tool_use_id)
        if (t) { t.status = 'done'; t.result = ev.content; break }
      }
    }
  } else if (ev.type === 'text') {
    const last = next[next.length - 1]
    if (last?.kind === 'text') {
      last.text += ev.text
    } else {
      next.push({ kind: 'text', text: ev.text })
    }
  }

  return next
}

export function finalizeMessages(
  segments: StreamSegment[],
  finalText: string,
  finalMedia: Array<{ type: string; url: string }> | undefined,
  idGen: () => number,
): DisplayItem[] {
  if (!finalText) return []
  const items: DisplayItem[] = []

  // Preserve interleaved order: emit each segment as a DisplayItem
  for (const seg of segments) {
    if (seg.kind === 'tools') {
      items.push({
        kind: 'tool_calls',
        calls: seg.tools.map((t) => ({
          name: t.name,
          input: typeof t.input === 'string' ? t.input : JSON.stringify(t.input ?? ''),
          result: t.result,
        })),
        _id: idGen(),
      })
    } else {
      items.push({ kind: 'text', role: 'assistant', text: seg.text, _id: idGen() })
    }
  }

  // Final text from the done event (the complete response)
  // If the last segment was already a text block, replace it with finalText + media
  // (the done event's text is the authoritative final version)
  const lastItem = items[items.length - 1]
  if (lastItem?.kind === 'text' && lastItem.role === 'assistant') {
    lastItem.text = finalText
    lastItem.media = finalMedia
  } else {
    items.push({ kind: 'text', role: 'assistant', text: finalText, media: finalMedia, _id: idGen() })
  }

  return items
}

// ==================== Hook ====================

interface UseChatOptions {
  channel: string
  onSSEStatus?: (connected: boolean) => void
}

export interface UseChatReturn {
  messages: DisplayItem[]
  streamSegments: StreamSegment[]
  isWaiting: boolean
  send: (text: string) => Promise<void>
  abort: () => void
}

export function useChat({ channel, onSSEStatus }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<DisplayItem[]>([])
  const [streamSegments, setStreamSegments] = useState<StreamSegment[]>([])
  const [isWaiting, setIsWaiting] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const nextId = useRef(0)
  const channelRef = useRef(channel)
  channelRef.current = channel

  // Load chat history when channel changes
  useEffect(() => {
    const ch = channel === 'default' ? undefined : channel
    chatApi.history(100, ch).then(({ messages: msgs }) => {
      setMessages(msgs.map((m): DisplayItem => {
        if (m.kind === 'text' && m.metadata?.kind === 'notification') {
          return { ...m, role: 'notification', _id: nextId.current++ }
        }
        return { ...m, _id: nextId.current++ }
      }))
    }).catch((err) => {
      console.warn('Failed to load history:', err)
    })
  }, [channel])

  // SSE for push notifications (heartbeat, cron, multi-tab sync)
  const sseChannel = channel === 'default' ? undefined : channel
  useSSE({
    url: sseChannel ? `/api/chat/events?channel=${encodeURIComponent(sseChannel)}` : '/api/chat/events',
    onMessage: (data) => {
      if (data.type === 'message' && data.text) {
        const role = data.kind === 'message' ? 'assistant' : 'notification'
        setMessages((prev) => [
          ...prev,
          { kind: 'text', role, text: data.text, media: data.media, _id: nextId.current++ },
        ])
      }
    },
    onStatus: channel === 'default' ? onSSEStatus : undefined,
  })

  // Abort streaming on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort() }
  }, [])

  const send = useCallback(async (text: string) => {
    setStreamSegments([])
    setMessages((prev) => [...prev, { kind: 'text', role: 'user', text, _id: nextId.current++ }])
    setIsWaiting(true)

    const abort = new AbortController()
    abortRef.current = abort

    try {
      const ch = channelRef.current === 'default' ? undefined : channelRef.current
      let finalText = ''
      let finalMedia: Array<{ type: string; url: string }> | undefined
      let segments: StreamSegment[] = []

      for await (const event of chatApi.sendStreaming(text, ch, abort.signal)) {
        if (event.type === 'stream') {
          segments = reduceStreamEvent(segments, event.event)
          setStreamSegments(segments)
        } else if (event.type === 'done') {
          finalText = event.text
          finalMedia = event.media?.length ? event.media : undefined
        }
      }

      setStreamSegments([])
      const newItems = finalizeMessages(segments, finalText, finalMedia, () => nextId.current++)
      if (newItems.length > 0) {
        setMessages((prev) => [...prev, ...newItems])
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setStreamSegments([])
      const msg = err instanceof Error ? err.message : 'Unknown error'
      setMessages((prev) => [
        ...prev,
        { kind: 'text', role: 'notification', text: `Error: ${msg}`, _id: nextId.current++ },
      ])
    } finally {
      setIsWaiting(false)
      abortRef.current = null
    }
  }, [])

  const abortFn = useCallback(() => { abortRef.current?.abort() }, [])

  return { messages, streamSegments, isWaiting, send, abort: abortFn }
}

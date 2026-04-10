import { useState, useEffect, useCallback } from 'react'
import { Section } from '../components/form'
import { PageHeader } from '../components/PageHeader'
import { Spinner, EmptyState } from '../components/StateViews'
import { useToast } from '../components/Toast'
import {
  devApi,
  type RegistryResponse,
  type SessionInfo,
} from '../api/dev'

export function DevPage() {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title="Dev" />

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        <div className="max-w-[640px] space-y-5">
          <RegistrySection />
          <SendSection />
          <SessionsSection />
        </div>
      </div>
    </div>
  )
}

// ==================== Registry ====================

function RegistrySection() {
  const [data, setData] = useState<RegistryResponse | null>(null)

  const refresh = useCallback(() => {
    devApi.registry().then(setData).catch(() => {})
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return (
    <Section title="Connector Registry" description="Active connectors and last user interaction.">
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={refresh}
          className="px-2.5 py-1 text-xs bg-bg-tertiary text-text-muted rounded hover:text-text transition-colors"
        >
          Refresh
        </button>
      </div>

      {data && (
        <div className="space-y-2">
          {data.connectors.length === 0 ? (
            <p className="text-sm text-text-muted">No connectors registered.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted text-xs">
                  <th className="pb-1 pr-3">Channel</th>
                  <th className="pb-1 pr-3">To</th>
                  <th className="pb-1 pr-3">Push</th>
                  <th className="pb-1">Media</th>
                </tr>
              </thead>
              <tbody>
                {data.connectors.map((cn) => (
                  <tr key={cn.channel} className="text-text hover:bg-bg-tertiary/30 transition-colors">
                    <td className="py-0.5 pr-3 font-mono text-xs">{cn.channel}</td>
                    <td className="py-0.5 pr-3 font-mono text-xs">{cn.to}</td>
                    <td className="py-0.5 pr-3">{cn.capabilities.push ? 'yes' : 'no'}</td>
                    <td className="py-0.5">{cn.capabilities.media ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="pt-2 text-xs text-text-muted">
            Last interaction:{' '}
            {data.lastInteraction ? (
              <span className="font-mono">
                {data.lastInteraction.channel}:{data.lastInteraction.to}{' '}
                ({new Date(data.lastInteraction.ts).toLocaleTimeString()})
              </span>
            ) : (
              'none'
            )}
          </div>
        </div>
      )}
    </Section>
  )
}

// ==================== Test Send ====================

function SendSection() {
  const [channels, setChannels] = useState<string[]>([])
  const [channel, setChannel] = useState('')
  const [kind, setKind] = useState<'message' | 'notification'>('notification')
  const [text, setText] = useState('')
  const [source, setSource] = useState<'manual' | 'heartbeat' | 'cron'>('manual')
  const [sending, setSending] = useState(false)
  const toast = useToast()

  useEffect(() => {
    devApi.registry().then((r) => {
      setChannels(r.connectors.map((cn) => cn.channel))
    }).catch(() => {})
  }, [])

  const handleSend = useCallback(async () => {
    if (!text.trim()) return
    setSending(true)
    try {
      const res = await devApi.send({
        channel: channel || undefined,
        kind,
        text: text.trim(),
        source,
      })
      toast.success(`Sent to ${res.channel}:${res.to}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }, [channel, kind, text, source, toast])

  const selectClass = 'px-2.5 py-2 bg-bg text-text border border-border rounded-md text-sm outline-none focus:border-accent'

  return (
    <Section title="Test Send" description="Send a test message or notification through the connector pipeline.">
      <div className="space-y-3">
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-[13px] text-text-muted mb-1">Channel</label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className={selectClass + ' w-full'}
            >
              <option value="">auto (resolveDeliveryTarget)</option>
              {channels.map((ch) => (
                <option key={ch} value={ch}>{ch}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[13px] text-text-muted mb-1">Kind</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
              className={selectClass}
            >
              <option value="notification">notification</option>
              <option value="message">message</option>
            </select>
          </div>
          <div>
            <label className="block text-[13px] text-text-muted mb-1">Source</label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as typeof source)}
              className={selectClass}
            >
              <option value="manual">manual</option>
              <option value="heartbeat">heartbeat</option>
              <option value="cron">cron</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[13px] text-text-muted mb-1">Message</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Test message..."
            rows={3}
            className="w-full px-2.5 py-2 bg-bg text-text border border-border rounded-md font-sans text-sm outline-none transition-colors focus:border-accent resize-y"
          />
        </div>

        <button
          onClick={handleSend}
          disabled={sending || !text.trim()}
          className="btn-primary-sm"
        >
          {sending ? 'Sending...' : 'Send'}
        </button>

      </div>
    </Section>
  )
}

// ==================== Sessions ====================

function SessionsSection() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)

  useEffect(() => {
    devApi.sessions().then(setSessions).catch(() => {})
  }, [])

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <Section title="Sessions" description="Active session files on disk.">
      {sessions === null ? (
        <div className="flex justify-center py-6"><Spinner size="sm" /></div>
      ) : sessions.length === 0 ? (
        <EmptyState title="No sessions found." />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-muted text-xs">
              <th className="pb-1 pr-3">Session ID</th>
              <th className="pb-1 text-right">Size</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="text-text hover:bg-bg-tertiary/30 transition-colors">
                <td className="py-0.5 pr-3 font-mono text-xs">{s.id}</td>
                <td className="py-0.5 text-right text-xs text-text-muted">{formatSize(s.sizeBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

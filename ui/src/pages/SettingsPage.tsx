import { useState, useEffect, useCallback, useMemo } from 'react'
import { api, type AppConfig } from '../api'
import { Toggle } from '../components/Toggle'
import { SaveIndicator } from '../components/SaveIndicator'
import { ConfigSection, Field, inputClass } from '../components/form'
import { useAutoSave } from '../hooks/useAutoSave'
import { PageHeader } from '../components/PageHeader'
import { PageLoading } from '../components/StateViews'

export function SettingsPage() {
  const [config, setConfig] = useState<AppConfig | null>(null)

  useEffect(() => {
    api.config.load().then(setConfig).catch(() => {})
  }, [])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title="Settings" />

      {config ? (
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
          <div className="max-w-[880px] mx-auto">
            {/* Agent */}
            <ConfigSection title="Agent" description="Controls file-system and tool permissions for the AI. Changes apply on the next request.">
              <div className="flex items-center justify-between gap-4 py-1">
                <div className="flex-1">
                  <span className="text-sm font-medium text-text">
                    Evolution Mode
                  </span>
                  <p className="text-[12px] text-text-muted mt-0.5 leading-relaxed">
                    {config.agent?.evolutionMode
                      ? 'Full project access — AI can modify source code'
                      : 'Sandbox mode — AI can only edit data/brain/'}
                  </p>
                </div>
                <Toggle
                  checked={config.agent?.evolutionMode || false}
                  onChange={async (v) => {
                    try {
                      await api.config.updateSection('agent', { ...config.agent, evolutionMode: v })
                      setConfig((c) => c ? { ...c, agent: { ...c.agent, evolutionMode: v } } : c)
                    } catch {
                      // Toggle doesn't flip on failure
                    }
                  }}
                />
              </div>
            </ConfigSection>

            {/* Compaction */}
            <ConfigSection title="Compaction" description="Context window management. When conversation size approaches Max Context minus Max Output tokens, older messages are automatically summarized to free up space.">
              <CompactionForm config={config} />
            </ConfigSection>
          </div>
      </div>
      ) : (
        <PageLoading />
      )}
    </div>
  )
}

// ==================== Form Sections ====================

function CompactionForm({ config }: { config: AppConfig }) {
  const [ctx, setCtx] = useState(String(config.compaction?.maxContextTokens || ''))
  const [out, setOut] = useState(String(config.compaction?.maxOutputTokens || ''))

  const data = useMemo(
    () => ({ maxContextTokens: Number(ctx), maxOutputTokens: Number(out) }),
    [ctx, out],
  )

  const save = useCallback(async (d: { maxContextTokens: number; maxOutputTokens: number }) => {
    await api.config.updateSection('compaction', d)
  }, [])

  const { status, retry } = useAutoSave({ data, save })

  return (
    <>
      <Field label="Max Context Tokens">
        <input className={inputClass} type="number" step={1000} value={ctx} onChange={(e) => setCtx(e.target.value)} />
      </Field>
      <Field label="Max Output Tokens">
        <input className={inputClass} type="number" step={1000} value={out} onChange={(e) => setOut(e.target.value)} />
      </Field>
      <SaveIndicator status={status} onRetry={retry} />
    </>
  )
}


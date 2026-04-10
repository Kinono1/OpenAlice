import { useMemo, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { PageLoading } from '../components/StateViews'
import { Field, inputClass } from '../components/form'
import { Toggle } from '../components/Toggle'
import { useStrategyRuntime } from '../hooks/useStrategyRuntime'
import { api } from '../api'
import type { StrategyEvaluationSnapshot } from '../api/types'

export function StrategyPage() {
  const { config, runtime, loading, error, saveConfig } = useStrategyRuntime()
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [evalSymbol, setEvalSymbol] = useState('BTC/USD')
  const [evalSource, setEvalSource] = useState('')
  const [evalExchangeId, setEvalExchangeId] = useState('')
  const [evalWinRate, setEvalWinRate] = useState('0.55')
  const [evalWinLoss, setEvalWinLoss] = useState('1.5')
  const [evalAssetLayer, setEvalAssetLayer] = useState<'core' | 'extended' | 'watch-only'>('core')
  const [evalSide, setEvalSide] = useState<'buy' | 'sell'>('buy')
  const [evalRequestedUsdSize, setEvalRequestedUsdSize] = useState('1000')
  const [evalRequestedSize, setEvalRequestedSize] = useState('')
  const [evalPrice, setEvalPrice] = useState('')
  const [evalReduceOnly, setEvalReduceOnly] = useState(false)
  const [snapshot, setSnapshot] = useState<StrategyEvaluationSnapshot | null>(null)
  const [evalLoading, setEvalLoading] = useState(false)

  const factorEntries = useMemo(
    () => Object.entries(config?.factors ?? {}),
    [config],
  )

  if (loading) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <PageHeader title="Strategy" description="Loading strategy runtime..." />
        <PageLoading />
      </div>
    )
  }

  if (!config || !runtime) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <PageHeader title="Strategy" description="Strategy runtime unavailable." />
        <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
          <p className="text-[13px] text-red">{error ?? 'Unknown strategy error'}</p>
        </div>
      </div>
    )
  }

  const patchConfig = async (next: typeof config) => {
    setSaving(true)
    setMessage(null)
    try {
      await saveConfig(next)
      setMessage('Saved')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const evaluateSymbol = async () => {
    setEvalLoading(true)
    setMessage(null)
    try {
      const next = await api.strategy.evaluate({
        symbol: evalSymbol,
        interval: '1h',
        source: evalSource || undefined,
        exchangeId: evalExchangeId || undefined,
        assetLayer: evalAssetLayer,
        winRate: Number(evalWinRate),
        avgWinLossRatio: Number(evalWinLoss),
        side: evalSide,
        requestedUsdSize: evalRequestedUsdSize ? Number(evalRequestedUsdSize) : undefined,
        requestedSize: evalRequestedSize ? Number(evalRequestedSize) : undefined,
        price: evalPrice ? Number(evalPrice) : undefined,
        reduceOnly: evalReduceOnly,
      })
      setSnapshot(next)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Evaluation failed')
    } finally {
      setEvalLoading(false)
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title="Strategy" description="Strategy governance, factors, and runtime readiness." />

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        <div className="max-w-[880px] space-y-5">
          <section className="rounded-lg border border-border bg-bg-secondary px-4 py-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Runtime</div>
                <div className="text-[14px] font-medium text-text mt-1">Current Strategy State</div>
              </div>
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${runtime.enabled ? 'bg-green/10 text-green' : 'bg-red/10 text-red'}`}>
                {runtime.enabled ? 'enabled' : 'disabled'}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px] text-text-muted">
              <RuntimeCell title="Market Scope" value={runtime.runtime.marketScope} />
              <RuntimeCell title="Freeze Active" value={runtime.eventCalendar.active.active ? 'yes' : 'no'} />
              <RuntimeCell title="Runtime Integration" value={runtime.readiness.runtimeIntegrationReady ? 'on' : 'off'} />
            </div>
            <div className="text-[12px] text-text-muted leading-relaxed">
              {runtime.readiness.notes.join(' ')}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-bg-secondary px-4 py-4 space-y-3">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Governance</div>
            <label className="flex items-center gap-2 cursor-pointer">
              <Toggle
                checked={config.enabled}
                onChange={(enabled) => patchConfig({ ...config, enabled })}
              />
              <span className="text-[12px] text-text-muted">Enable strategy runtime</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <Toggle
                checked={config.governance.useGovernanceGate}
                onChange={(useGovernanceGate) =>
                  patchConfig({
                    ...config,
                    governance: { ...config.governance, useGovernanceGate },
                  })}
              />
              <span className="text-[12px] text-text-muted">Use governance action gate</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <Toggle
                checked={config.runtime.runtimeIntegrationEnabled}
                onChange={(runtimeIntegrationEnabled) =>
                  patchConfig({
                    ...config,
                    runtime: { ...config.runtime, runtimeIntegrationEnabled },
                  })}
              />
              <span className="text-[12px] text-text-muted">Enable runtime integration flag</span>
            </label>
          </section>

          <section className="rounded-lg border border-border bg-bg-secondary px-4 py-4 space-y-3">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Factors</div>
            <div className="space-y-3">
              {factorEntries.map(([name, factor]) => (
                <div key={name} className="grid grid-cols-1 md:grid-cols-[1fr_120px] gap-3 items-center">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Toggle
                      checked={factor.enabled}
                      onChange={(enabled) =>
                        patchConfig({
                          ...config,
                          factors: {
                            ...config.factors,
                            [name]: { ...factor, enabled },
                          },
                        })}
                    />
                    <span className="text-[12px] text-text capitalize">{name}</span>
                  </label>
                  <Field label="Weight">
                    <input
                      className={inputClass}
                      type="number"
                      step="0.1"
                      value={factor.weight}
                      onChange={(e) =>
                        patchConfig({
                          ...config,
                          factors: {
                            ...config.factors,
                            [name]: { ...factor, weight: Number(e.target.value || 0) },
                          },
                        })}
                    />
                  </Field>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-bg-secondary px-4 py-4 space-y-3">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Event Calendar</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px] text-text-muted">
              <RuntimeCell title="Enabled" value={config.eventCalendar.enabled ? 'yes' : 'no'} />
              <RuntimeCell title="Configured Events" value={String(runtime.eventCalendar.configuredEventCount)} />
              <RuntimeCell title="Max Action In Freeze" value={runtime.eventCalendar.active.maxActionDuringFreeze ?? 'n/a'} />
            </div>
          </section>

          <section className="rounded-lg border border-border bg-bg-secondary px-4 py-4 space-y-3">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Evaluate Snapshot</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
              <Field label="Symbol">
                <input
                  className={inputClass}
                  value={evalSymbol}
                  onChange={(e) => setEvalSymbol(e.target.value)}
                />
              </Field>
              <Field label="Account Source (optional)">
                <input
                  className={inputClass}
                  value={evalSource}
                  onChange={(e) => setEvalSource(e.target.value)}
                  placeholder="bybit-main"
                />
              </Field>
              <Field label="Exchange Id (fallback)">
                <input
                  className={inputClass}
                  value={evalExchangeId}
                  onChange={(e) => setEvalExchangeId(e.target.value)}
                  placeholder="bybit"
                />
              </Field>
              <Field label="Win Rate">
                <input
                  className={inputClass}
                  type="number"
                  step="0.01"
                  value={evalWinRate}
                  onChange={(e) => setEvalWinRate(e.target.value)}
                />
              </Field>
              <Field label="Win/Loss Ratio">
                <input
                  className={inputClass}
                  type="number"
                  step="0.1"
                  value={evalWinLoss}
                  onChange={(e) => setEvalWinLoss(e.target.value)}
                />
              </Field>
              <Field label="Asset Layer">
                <select
                  className={inputClass}
                  value={evalAssetLayer}
                  onChange={(e) => setEvalAssetLayer(e.target.value as typeof evalAssetLayer)}
                >
                  <option value="core">core</option>
                  <option value="extended">extended</option>
                  <option value="watch-only">watch-only</option>
                </select>
              </Field>
              <Field label="Side">
                <select
                  className={inputClass}
                  value={evalSide}
                  onChange={(e) => setEvalSide(e.target.value as 'buy' | 'sell')}
                >
                  <option value="buy">buy</option>
                  <option value="sell">sell</option>
                </select>
              </Field>
              <Field label="Requested USD Size">
                <input
                  className={inputClass}
                  type="number"
                  step="0.01"
                  value={evalRequestedUsdSize}
                  onChange={(e) => setEvalRequestedUsdSize(e.target.value)}
                />
              </Field>
              <Field label="Requested Size">
                <input
                  className={inputClass}
                  type="number"
                  step="0.0001"
                  value={evalRequestedSize}
                  onChange={(e) => setEvalRequestedSize(e.target.value)}
                  placeholder="optional"
                />
              </Field>
              <Field label="Limit/Reference Price">
                <input
                  className={inputClass}
                  type="number"
                  step="0.01"
                  value={evalPrice}
                  onChange={(e) => setEvalPrice(e.target.value)}
                  placeholder="optional"
                />
              </Field>
              <label className="flex items-center gap-2 cursor-pointer pb-2">
                <Toggle checked={evalReduceOnly} onChange={setEvalReduceOnly} />
                <span className="text-[12px] text-text-muted">Reduce only</span>
              </label>
              <button
                onClick={evaluateSymbol}
                disabled={evalLoading || !evalSymbol.trim()}
                className="btn-primary"
              >
                {evalLoading ? 'Evaluating…' : 'Evaluate'}
              </button>
            </div>

            {snapshot && (
              <div className="space-y-3 text-[12px] text-text-muted">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <RuntimeCell title="Action" value={snapshot.governance.actionStatus} />
                  <RuntimeCell title="Score" value={snapshot.governance.breakdown.totalScore.toFixed(0)} />
                  <RuntimeCell title="Ensemble" value={snapshot.ensemble.aggregateValue.toFixed(3)} />
                  <RuntimeCell title="Freeze" value={snapshot.freeze.active ? 'active' : 'clear'} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <RuntimeCell title="Sizing Method" value={snapshot.positionSizing.method} />
                  <RuntimeCell title="Recommended %" value={snapshot.positionSizing.recommendedPctOfEquity.toFixed(3)} />
                  <RuntimeCell
                    title="Recommended Notional"
                    value={snapshot.positionSizing.recommendedNotionalUsd == null
                      ? 'n/a'
                      : snapshot.positionSizing.recommendedNotionalUsd.toFixed(2)}
                  />
                  <RuntimeCell title="Layer" value={snapshot.positionSizing.assetLayer} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <RuntimeCell title="Open Interest" value={snapshot.derivedMetrics.openInterest == null ? 'n/a' : snapshot.derivedMetrics.openInterest.toFixed(2)} />
                  <RuntimeCell title="OI Value" value={snapshot.derivedMetrics.openInterestValue == null ? 'n/a' : snapshot.derivedMetrics.openInterestValue.toFixed(2)} />
                  <RuntimeCell title="Liq Count 24h" value={snapshot.derivedMetrics.liquidationCount24h == null ? 'n/a' : snapshot.derivedMetrics.liquidationCount24h.toFixed(0)} />
                  <RuntimeCell title="Liq Notional 24h" value={snapshot.derivedMetrics.liquidationNotional24h == null ? 'n/a' : snapshot.derivedMetrics.liquidationNotional24h.toFixed(2)} />
                </div>
                {snapshot.dataProvenance && (
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <RuntimeCell title="Funding Source" value={`${snapshot.dataProvenance.fundingRate.source} / ${snapshot.dataProvenance.fundingRate.status}`} />
                    <RuntimeCell title="Basis Source" value={`${snapshot.dataProvenance.basis.source} / ${snapshot.dataProvenance.basis.status}`} />
                    <RuntimeCell title="OI Source" value={`${snapshot.dataProvenance.openInterest.source} / ${snapshot.dataProvenance.openInterest.status}`} />
                    <RuntimeCell title="Completeness" value={snapshot.dataProvenance.completeness} />
                  </div>
                )}
                {snapshot.executionPreview && (
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <RuntimeCell title="Execution Mode" value={snapshot.executionPreview.mode} />
                    <RuntimeCell title="Requested Notional" value={snapshot.executionPreview.requestedNotionalUsd == null ? 'n/a' : snapshot.executionPreview.requestedNotionalUsd.toFixed(2)} />
                    <RuntimeCell title="Effective Notional" value={snapshot.executionPreview.effectiveNotionalUsd == null ? 'n/a' : snapshot.executionPreview.effectiveNotionalUsd.toFixed(2)} />
                    <RuntimeCell title="Fallback" value={snapshot.executionPreview.fallbackReason ?? 'n/a'} />
                  </div>
                )}
                <div className="space-y-1">
                  {snapshot.factorSignals.map((signal) => (
                    <div key={signal.name} className="flex items-center justify-between gap-3 border-b border-border/60 pb-1">
                      <span className="capitalize text-text">{signal.name}</span>
                      <span>{signal.value.toFixed(3)} / conf {signal.confidence.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {(message || saving) && (
            <div className="text-[12px] text-text-muted">
              {saving ? 'Saving…' : message}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function RuntimeCell({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-text-muted/70">{title}</div>
      <div className="mt-1 text-[13px] text-text">{value}</div>
    </div>
  )
}

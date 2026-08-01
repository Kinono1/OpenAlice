import { useEffect, useState, type ReactNode } from 'react'
import { api, type SystemStatusV1 } from '../api'
import { PageHeader } from '../components/PageHeader'

const POSITIVE_VALUES = new Set(['trusted', 'fresh', 'healthy', 'pass', 'clean', 'true'])

export function statusTone(value: string, evidenceTrusted: boolean): string {
  if (value === 'missing' || value === 'unknown') return 'text-text-muted border-border bg-bg-tertiary/30'
  if (value === 'stale' || value === 'degraded') return 'text-[#d29922] border-[#d29922]/30 bg-[#d29922]/10'
  if (value === 'blocked' || value === 'dirty' || value === 'fail' || value === 'false') {
    return 'text-red border-red/30 bg-red/10'
  }
  if (evidenceTrusted && POSITIVE_VALUES.has(value)) return 'text-green border-green/30 bg-green/10'
  return 'text-text-muted border-border bg-bg-tertiary/30'
}

function Badge({
  value,
  trusted,
  testId,
}: {
  value: string
  trusted: boolean
  testId?: string
}) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusTone(value, trusted)}`}
    >
      {value}
    </span>
  )
}

function shortHash(value: string | null): string {
  if (!value) return 'missing'
  return value.length > 16 ? `${value.slice(0, 12)}…` : value
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return 'unknown age'
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s`
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`
  return `${(ageMs / 3_600_000).toFixed(1)}h`
}

function ReadonlyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/60 py-2 last:border-b-0">
      <span className="text-xs text-text-muted">{label}</span>
      <div className="min-w-0 text-right text-xs text-text">{children}</div>
    </div>
  )
}

export function SystemPage() {
  const [status, setStatus] = useState<SystemStatusV1 | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = () => api.system.status()
      .then((value) => {
        if (!active) return
        setStatus(value)
        setError(null)
      })
      .catch(() => {
        if (active) setError('System status unavailable')
      })
    void load()
    const timer = window.setInterval(load, 15_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const trusted = status?.statusSource === 'executed_receipt'
    && status.release.evidenceTrust === 'trusted'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="System Status"
        description="Authenticated, read-only operational evidence"
      />
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {error && <div className="mb-4 rounded-lg border border-red/30 bg-red/10 p-3 text-sm text-red">{error}</div>}
        {!status && !error && <div className="text-sm text-text-muted">Loading status…</div>}
        {status && (
          <div className="mx-auto max-w-6xl space-y-4">
            <div className="rounded-lg border border-border bg-bg-secondary p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-text">Evidence state</div>
                  <div className="mt-1 text-xs text-text-muted">
                    Generated {new Date(status.generatedAt).toLocaleString()}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Badge value={status.statusSource} trusted={trusted} testId="status-source" />
                  <Badge value={status.release.evidenceTrust} trusted={trusted} testId="evidence-trust" />
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-lg border border-border bg-bg-secondary p-4">
                <h3 className="mb-2 text-sm font-semibold text-text">Release</h3>
                <ReadonlyRow label="Current commit"><span className="font-mono">{shortHash(status.release.currentCommit)}</span></ReadonlyRow>
                <ReadonlyRow label="Previous commit"><span className="font-mono">{shortHash(status.release.previousCommit)}</span></ReadonlyRow>
                <ReadonlyRow label="Manifest"><span className="font-mono">{shortHash(status.release.manifestHash)}</span></ReadonlyRow>
                <ReadonlyRow label="Runtime role">{status.release.runtimeRole}</ReadonlyRow>
                <ReadonlyRow label="Dirty state"><Badge value={status.release.dirtyState} trusted={trusted} /></ReadonlyRow>
              </section>

              <section className="rounded-lg border border-border bg-bg-secondary p-4">
                <h3 className="mb-2 text-sm font-semibold text-text">Scheduler</h3>
                <ReadonlyRow label="Owner">{status.scheduler.owner ?? 'none'}</ReadonlyRow>
                <ReadonlyRow label="Successful jobs">{status.scheduler.success}</ReadonlyRow>
                <ReadonlyRow label="Failed or blocked jobs">{status.scheduler.failure}</ReadonlyRow>
                <ReadonlyRow label="Open circuits">{status.scheduler.circuitOpen}</ReadonlyRow>
                <ReadonlyRow label="External dependency pauses">{status.scheduler.pausedExternalDependency}</ReadonlyRow>
              </section>

              <section className="rounded-lg border border-border bg-bg-secondary p-4">
                <h3 className="mb-2 text-sm font-semibold text-text">Data freshness</h3>
                {Object.entries(status.dataFreshness).map(([name, value]) => (
                  <ReadonlyRow key={name} label={name}>
                    <span className="mr-2 text-text-muted">{formatAge(value.ageMs)}</span>
                    <Badge value={value.status} trusted={trusted} testId={`freshness-${name}`} />
                  </ReadonlyRow>
                ))}
              </section>

              <section className="rounded-lg border border-border bg-bg-secondary p-4">
                <h3 className="mb-2 text-sm font-semibold text-text">Pipeline registry</h3>
                <ReadonlyRow label="Registered">{status.pipelineRegistry.registered}</ReadonlyRow>
                <ReadonlyRow label="Total">{status.pipelineRegistry.total}</ReadonlyRow>
                <ReadonlyRow label="Coverage">{status.pipelineRegistry.coveragePct.toFixed(2)}%</ReadonlyRow>
                <ReadonlyRow label="Registry hash"><span className="font-mono">{shortHash(status.pipelineRegistry.registryHash)}</span></ReadonlyRow>
              </section>
            </div>

            <section className="rounded-lg border border-border bg-bg-secondary p-4">
              <h3 className="mb-2 text-sm font-semibold text-text">Research sidecars</h3>
              {status.sidecars.map((sidecar) => (
                <ReadonlyRow key={sidecar.source} label={sidecar.source}>
                  <span className="mr-2 font-mono text-text-muted">{shortHash(sidecar.commit)}</span>
                  <Badge value={sidecar.status} trusted={trusted} testId={`sidecar-${sidecar.source}`} />
                  <div className="mt-1 text-[11px] text-text-muted">{sidecar.reason}</div>
                </ReadonlyRow>
              ))}
            </section>

            <section className="rounded-lg border border-border bg-bg-secondary p-4">
              <h3 className="mb-2 text-sm font-semibold text-text">Promotion and admission</h3>
              <ReadonlyRow label="Promotion stage">{status.admission.stage}</ReadonlyRow>
              <ReadonlyRow label="Paper trading"><Badge value={String(status.admission.paperTradingAllowed)} trusted={trusted} /></ReadonlyRow>
              <ReadonlyRow label="Live trading"><Badge value={String(status.admission.liveTradingAllowed)} trusted={trusted} /></ReadonlyRow>
              <ReadonlyRow label="Live execution arm"><Badge value={String(status.admission.liveExecutionArmed)} trusted={trusted} /></ReadonlyRow>
              <ReadonlyRow label="Admission expires">{new Date(status.admission.expiresAt).toLocaleString()}</ReadonlyRow>
              <ReadonlyRow label="Evidence references">{status.evidenceRefs.length}</ReadonlyRow>
              <div className="pt-3">
                <div className="text-xs text-text-muted">Blockers</div>
                {status.admission.blockingReasons.length === 0 ? (
                  <div className="mt-1 text-xs text-text-muted">None reported</div>
                ) : (
                  <ul className="mt-2 space-y-1 text-xs text-red">
                    {status.admission.blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                )}
              </div>
              <div className="mt-4 rounded-md border border-border bg-bg p-3 text-xs text-text">
                Next action: <span className="font-mono">{status.nextAction}</span>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

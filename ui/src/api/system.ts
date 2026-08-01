import { fetchJson } from './client'

export type EvidenceState = 'trusted' | 'stale' | 'blocked'
export type FreshnessState = 'fresh' | 'stale' | 'missing'

export interface AdmissionDecisionV1 {
  schemaVersion: 'admission_decision.v1'
  decisionId: string
  candidateId: string | null
  evaluatedAt: string
  expiresAt: string
  sourceCommit: string
  dirtyStateHash: string
  releaseManifestHash: string
  stage: string
  paperTradingAllowed: boolean
  liveTradingAllowed: boolean
  liveExecutionArmed: boolean
  gateResults: Array<{
    gateId: string
    status: 'pass' | 'fail' | 'unknown' | 'stale'
    evidenceRefs: string[]
    reasonCodes: string[]
  }>
  blockingReasons: string[]
  evidenceRefs: string[]
  approvalRefs: string[]
  accountScope: string[]
  assetScope: string[]
}

export interface SystemStatusV1 {
  schemaVersion: 'system_status.v1'
  generatedAt: string
  statusSource: 'executed_receipt' | 'stale' | 'missing'
  release: {
    currentCommit: string | null
    previousCommit: string | null
    manifestHash: string | null
    runtimeRole: 'primary' | 'canary' | 'test'
    dirtyState: 'clean' | 'dirty' | 'unknown'
    evidenceTrust: EvidenceState
  }
  scheduler: {
    owner: 'openalice_cron_engine' | null
    success: number
    failure: number
    circuitOpen: number
    pausedExternalDependency: number
  }
  dataFreshness: Record<string, {
    status: FreshnessState
    ageMs: number | null
    evidenceRef: string | null
  }>
  pipelineRegistry: {
    registered: number
    total: number
    coveragePct: number
    registryHash: string | null
  }
  sidecars: Array<{
    source: 'tradingagents' | 'alphaswarm'
    commit: string | null
    status: 'healthy' | 'degraded' | 'blocked' | 'unknown'
    lastReceiptAt: string | null
    reason: string
  }>
  admission: AdmissionDecisionV1
  nextAction: string
  evidenceRefs: string[]
}

export const systemApi = {
  status(): Promise<SystemStatusV1> {
    return fetchJson<SystemStatusV1>('/api/system/status')
  },
}

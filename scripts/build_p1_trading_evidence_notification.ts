import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_INDEX_PATH = 'data/runtime/p1_trading_evidence/p1_trading_evidence.index.latest.json'
const DEFAULT_META_LABEL_READINESS_PATH = 'data/runtime/meta_labeling_shadow_readiness.latest.json'
const DEFAULT_NOTIFICATION_PATH = 'data/runtime/p1_trading_evidence_notification.json'

interface Args {
  indexPath: string
  metaLabelReadinessPath: string
  outputPath: string | null
  json: boolean
}

export interface P1TradingEvidenceNotification {
  shouldNotify: boolean
  deliveryDecision: 'notify' | 'suppress'
  headline: string
  blockers: string[]
  metaBlockers: string[]
  trialSourceTargets: Array<Record<string, unknown>>
  openPositionReadiness: Record<string, unknown>
  routeCostShadowEligibility: {
    routeBudgetStatus: string
    selectedRoute: string
    feeSnapshotStatus: string
    blockers: string[]
  }
  fullText: string
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const notification = await buildP1TradingEvidenceNotificationFromFiles(args)
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(notification, null, 2)}\n`, 'utf-8')
  }
  if (args.json) {
    console.log(JSON.stringify(notification, null, 2))
  } else {
    console.log(notification.fullText)
  }
}

export function parseArgs(argv: string[]): Args {
  const raw = parseRawArgs(argv)
  return {
    indexPath: raw.get('indexPath') ?? raw.get('index') ?? DEFAULT_INDEX_PATH,
    metaLabelReadinessPath: raw.get('metaLabelReadinessPath') ??
      raw.get('metaPath') ??
      DEFAULT_META_LABEL_READINESS_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_NOTIFICATION_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function buildP1TradingEvidenceNotificationFromFiles(
  args: Args,
): Promise<P1TradingEvidenceNotification> {
  const index = asRecord(await readJson(args.indexPath))
  const artifacts = asRecord(index.artifacts)
  const gatePath = stringOrThrow(artifacts?.gateEffectiveness, 'missing gateEffectiveness artifact path')
  const costPath = stringOrThrow(artifacts?.costModelDiagnostics, 'missing costModelDiagnostics artifact path')
  const mfePath = stringOrThrow(artifacts?.mfeMaeStoploss, 'missing mfeMaeStoploss artifact path')
  const trialSourcePath = stringOrNull(artifacts?.trialSourceCoverage)
  return buildP1TradingEvidenceNotification({
    indexPath: args.indexPath,
    metaLabelReadinessPath: args.metaLabelReadinessPath,
    trialSourcePath,
    gate: await readJson(gatePath),
    cost: await readJson(costPath),
    mfe: await readJson(mfePath),
    trialSource: trialSourcePath ? await readJson(trialSourcePath) : null,
    meta: await readJson(args.metaLabelReadinessPath),
  })
}

export function buildP1TradingEvidenceNotification(input: {
  indexPath: string
  metaLabelReadinessPath: string
  trialSourcePath: string | null
  gate: unknown
  cost: unknown
  mfe: unknown
  trialSource: unknown
  meta: unknown
}): P1TradingEvidenceNotification {
  const gate = asRecord(input.gate) ?? {}
  const cost = asRecord(input.cost) ?? {}
  const mfe = asRecord(input.mfe) ?? {}
  const trialSource = asRecord(input.trialSource)
  const meta = asRecord(input.meta) ?? {}
  const ca = asRecord(gate.costAdjusted) ?? {}
  const openReady = asRecord(cost.openPositionReadiness) ?? {}
  const routeCost = asRecord(cost.routeCostShadowEligibility) ?? {}
  const routeCostBlockers = readStringArray(routeCost.blockers)
  const routeBudgetStatus = readString(routeCost.routeBudgetStatus) ?? 'missing'
  const selectedRoute = readString(routeCost.selectedRoute) ?? 'missing'
  const feeSnapshotStatus = readString(routeCost.feeSnapshotStatus) ?? 'missing'
  const acceptedClosedTrades = readNumber(ca.acceptedClosedTrades) ?? 0
  const acceptedCostCoverage = acceptedClosedTrades > 0
    ? `${readNumber(ca.acceptedWithPredictedCost) ?? 0}/${acceptedClosedTrades}`
    : '0/0'
  const blockers: string[] = []
  if (gate.gateStatus === 'harmful') blockers.push('gate_harmful')
  if (gate.gateStatus === 'insufficient_data') blockers.push('gate_insufficient_data')
  const acceptedMissingPredictedCost = readNumber(ca.acceptedMissingPredictedCost) ?? 0
  if (acceptedMissingPredictedCost > 0) blockers.push(`accepted_cost_missing:${acceptedMissingPredictedCost}`)
  const openReadyStatus = readString(openReady.status)
  if (openReadyStatus && openReadyStatus !== 'ok' && openReadyStatus !== 'insufficient_data') {
    blockers.push(`open_position_readiness:${openReadyStatus}`)
  }
  if (cost.quarantine === true) blockers.push('cost_quarantine')
  if (routeBudgetStatus !== 'pass') blockers.push(`route_cost_shadow_budget_status:${routeBudgetStatus}`)
  for (const blocker of routeCostBlockers) blockers.push(blocker)
  const stopLossTrades = readNumber(asRecord(mfe.coverage)?.stopLossTrades) ?? 0
  if (stopLossTrades >= 20) blockers.push('stop_loss_cluster')
  if (trialSource?.status === 'blocked') blockers.push('trial_source_coverage_blocked')
  if (meta.status === 'blocked') blockers.push('meta_labeling_blocked')

  const metaBlockers = readStringArray(meta.blockers).slice(0, 5)
  const trialSourceTargets = Array.isArray(trialSource?.nextPatchTargets)
    ? trialSource.nextPatchTargets.filter(isRecord).slice(0, 5)
    : []
  const notify = blockers.length > 0
  const routeCostBlockerText = routeCostBlockers.length > 0 ? routeCostBlockers.join('|') : 'none'
  const fullText = [
    'P1 trading evidence completed',
    `gateStatus=${readString(gate.gateStatus) ?? 'unknown'}`,
    `gateStatusBasis=${readString(gate.gateStatusBasis) ?? 'unknown'}`,
    `gateStatusDeltaPct=${readNumber(gate.gateStatusDeltaPct) ?? 'null'}`,
    `accepted=${readNumber(gate.accepted) ?? 'null'}`,
    `skipped=${readNumber(gate.skipped) ?? 'null'}`,
    `acceptVsSkipDeltaPct=${readNumber(gate.acceptVsSkipDeltaPct) ?? 'null'}`,
    `acceptVsSkipNetDeltaPct=${readNumber(ca.acceptVsSkipNetDeltaPct) ?? 'null'}`,
    `acceptedCostCoverage=${acceptedCostCoverage}`,
    `skippedCostCoverage=${readNumber(ca.skippedWithPredictedCost) ?? 'null'}/${readNumber(ca.skippedClosedOutcomes) ?? 'null'}`,
    `openPositionReadiness=${openReadyStatus ?? 'missing'}`,
    `openPositions=${readNumber(openReady.totalOpenPositions) ?? 'null'}`,
    `openPositionsNew=${readNumber(openReady.newOpenPositions) ?? 'null'}`,
    `openPositionsMissingPredictedOpenEvidence=${readNumber(openReady.missingPredictedOpenEvidence) ?? 'null'}`,
    `openPositionsLegacy=${readNumber(openReady.legacyOpenPositions) ?? 'null'}`,
    `costQuarantine=${cost.quarantine === true}`,
    `costQuarantineReasons=${readStringArray(cost.quarantineReasons).join('|') || 'unknown'}`,
    `routeBudgetStatus=${routeBudgetStatus}`,
    `routeSelected=${selectedRoute}`,
    `routeFeeSnapshotStatus=${feeSnapshotStatus}`,
    `routeCostBlockers=${routeCostBlockerText}`,
    `stopLossTrades=${stopLossTrades}`,
    `trialSourceCoverageStatus=${trialSource ? readString(trialSource.status) ?? 'unknown' : 'missing'}`,
    `trialSourceTopTargets=${trialSourceTargets.map(renderTrialSourceTarget).join('|')}`,
    `metaLabelingStatus=${readString(meta.status) ?? 'unknown'}`,
    `metaTrainingAllowed=${meta.trainingAllowed === true}`,
    `metaBlockers=${metaBlockers.join('|')}`,
    `blockers=${uniqueStrings(blockers).join('|')}`,
    `index=${input.indexPath}`,
    `trialSourceCoverage=${input.trialSourcePath ?? 'missing'}`,
    `metaLabelReadiness=${input.metaLabelReadinessPath}`,
  ].join(', ')

  return {
    shouldNotify: notify,
    deliveryDecision: notify ? 'notify' : 'suppress',
    headline: `P1 trading evidence: gate=${readString(gate.gateStatus) ?? 'unknown'}, cost=${acceptedCostCoverage}, open=${openReadyStatus ?? 'missing'}, route=${routeBudgetStatus}/${selectedRoute}, stopLoss=${stopLossTrades}, trialSource=${trialSource ? readString(trialSource.status) ?? 'unknown' : 'missing'}, meta=${readString(meta.status) ?? 'unknown'}`,
    blockers: uniqueStrings(blockers),
    metaBlockers,
    trialSourceTargets,
    openPositionReadiness: openReady,
    routeCostShadowEligibility: {
      routeBudgetStatus,
      selectedRoute,
      feeSnapshotStatus,
      blockers: routeCostBlockers,
    },
    fullText,
  }
}

function renderTrialSourceTarget(value: Record<string, unknown>): string {
  return [
    readString(value.source) ?? 'unknown',
    readString(value.familyId) ?? 'unknown',
    `missingP=${readNumber(value.missingPValueTrials) ?? 'null'}`,
    `missingFdr=${readNumber(value.missingFdrReportTrials) ?? 'null'}`,
    `pitMissing=${readNumber(value.pitAuditNotImplementedTrials) ?? 'null'}`,
  ].join(':')
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8'))
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const body = token.slice(2)
    const equals = body.indexOf('=')
    if (equals >= 0) {
      out.set(body.slice(0, equals), body.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(body, next)
      index += 1
    } else {
      out.set(body, 'true')
    }
  }
  return out
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function parseNullablePath(raw: string | undefined): string | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' || normalized === '-' ? null : raw
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) != null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function stringOrNull(value: unknown): string | null {
  return readString(value)
}

function stringOrThrow(value: unknown, message: string): string {
  const text = stringOrNull(value)
  if (!text) throw new Error(message)
  return text
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

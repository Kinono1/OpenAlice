import { hashEvidenceComponent } from '../evidence/evidence_id.js'

export const DATA_LINEAGE_SCHEMA_VERSION = 'data_lineage.v4_1'
export const DATA_LINEAGE_PIT_POLICY = 'available_time <= decision_time'

export const DATA_LINEAGE_NODE_TYPES = [
  'raw_source',
  'normalized_series',
  'feature',
  'strategy_input',
  'decision_artifact',
] as const

export const DATA_LINEAGE_QUALITY_STATUSES = [
  'ok',
  'degraded',
  'stale',
  'blocked',
  'observation_only',
  'unknown_lineage',
  'proxy_only',
] as const

export type DataLineageNodeType = (typeof DATA_LINEAGE_NODE_TYPES)[number]
export type DataLineageQualityStatus = (typeof DATA_LINEAGE_QUALITY_STATUSES)[number]

export interface DataLineageNode {
  id: string
  type: DataLineageNodeType
  qualityStatus: DataLineageQualityStatus
  parents?: string[]
  source?: string | null
  endpoint?: string | null
  symbol?: string | null
  firstTimestamp?: string | null
  lastTimestamp?: string | null
  availableTimePolicy?: string | null
  metadata?: Record<string, unknown>
}

export interface DataLineageGraph {
  schemaVersion: string
  generatedAt: string
  nodes: DataLineageNode[]
}

export interface DataLineageValidationResult {
  passed: boolean
  blockingReasons: Array<{
    code: string
    nodeId?: string
    parentId?: string
    required?: string
    observed?: string
    qualityStatus?: DataLineageQualityStatus
  }>
  hash: string
}

export function validateDataLineageGraph(
  graph: DataLineageGraph,
): DataLineageValidationResult {
  const blockingReasons: DataLineageValidationResult['blockingReasons'] = []
  const nodeIds = new Set<string>()
  const duplicateNodeIds = new Set<string>()

  if (graph.schemaVersion !== DATA_LINEAGE_SCHEMA_VERSION) {
    blockingReasons.push({
      code: 'DATA_LINEAGE_SCHEMA_VERSION_MISMATCH',
      required: DATA_LINEAGE_SCHEMA_VERSION,
      observed: graph.schemaVersion,
    })
  }

  if (graph.nodes.length === 0) {
    blockingReasons.push({
      code: 'DATA_LINEAGE_GRAPH_EMPTY',
    })
  }

  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) duplicateNodeIds.add(node.id)
    nodeIds.add(node.id)
  }

  for (const duplicateId of duplicateNodeIds) {
    blockingReasons.push({
      code: 'DUPLICATE_LINEAGE_NODE_ID',
      nodeId: duplicateId,
    })
  }

  for (const node of graph.nodes) {
    if (node.qualityStatus !== 'ok') {
      blockingReasons.push({
        code: lineageQualityBlockCode(node.qualityStatus),
        nodeId: node.id,
        qualityStatus: node.qualityStatus,
      })
    }

    for (const parentId of node.parents ?? []) {
      if (!nodeIds.has(parentId)) {
        blockingReasons.push({
          code: 'MISSING_LINEAGE_PARENT',
          nodeId: node.id,
          parentId,
        })
      }
    }

    if (!requiresAvailableTimePolicy(node.type)) continue

    const policy = node.availableTimePolicy?.trim() ?? ''
    if (!policy) {
      blockingReasons.push({
        code: `${lineageNodeTypeCodePrefix(node.type)}_MISSING_AVAILABLE_TIME_POLICY`,
        nodeId: node.id,
      })
      continue
    }
    if (normalizeAvailableTimePolicy(policy) !== DATA_LINEAGE_PIT_POLICY) {
      blockingReasons.push({
        code: `${lineageNodeTypeCodePrefix(node.type)}_NON_PIT_AVAILABLE_TIME_POLICY`,
        nodeId: node.id,
      })
    }
  }

  return {
    passed: blockingReasons.length === 0,
    blockingReasons,
    hash: hashDataLineageGraph(graph),
  }
}

function requiresAvailableTimePolicy(type: DataLineageNodeType): boolean {
  return type === 'feature' || type === 'strategy_input' || type === 'decision_artifact'
}

function lineageNodeTypeCodePrefix(type: DataLineageNodeType): string {
  switch (type) {
    case 'feature':
      return 'FEATURE'
    case 'strategy_input':
      return 'STRATEGY_INPUT'
    case 'decision_artifact':
      return 'DECISION_ARTIFACT'
    case 'raw_source':
      return 'RAW_SOURCE'
    case 'normalized_series':
      return 'NORMALIZED_SERIES'
  }
}

function normalizeAvailableTimePolicy(policy: string): string {
  return policy.trim().replaceAll(/\s+/g, ' ')
}

function lineageQualityBlockCode(status: DataLineageQualityStatus): string {
  switch (status) {
    case 'degraded':
      return 'LINEAGE_NODE_QUALITY_DEGRADED'
    case 'stale':
      return 'LINEAGE_NODE_QUALITY_STALE'
    case 'blocked':
      return 'LINEAGE_NODE_QUALITY_BLOCKED'
    case 'observation_only':
      return 'LINEAGE_NODE_OBSERVATION_ONLY'
    case 'unknown_lineage':
      return 'LINEAGE_NODE_UNKNOWN_LINEAGE'
    case 'proxy_only':
      return 'LINEAGE_NODE_PROXY_ONLY'
    case 'ok':
      return 'LINEAGE_NODE_QUALITY_OK'
  }
}

export function dataLineageGraphToJson(graph: DataLineageGraph): Record<string, unknown> {
  return {
    schema_version: graph.schemaVersion,
    generated_at: graph.generatedAt,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      quality_status: node.qualityStatus,
      parents: node.parents ?? [],
      source: node.source ?? null,
      endpoint: node.endpoint ?? null,
      symbol: node.symbol ?? null,
      first_timestamp: node.firstTimestamp ?? null,
      last_timestamp: node.lastTimestamp ?? null,
      available_time_policy: node.availableTimePolicy ?? null,
      metadata: node.metadata ?? {},
    })),
  }
}

export function hashDataLineageGraph(graph: DataLineageGraph): string {
  return hashEvidenceComponent(dataLineageGraphToJson(graph))
}

export function dataLineageGraphFromJson(value: unknown): DataLineageGraph {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('data lineage graph must be an object')
  }
  const raw = value as Record<string, unknown>
  const nodesRaw = raw.nodes
  if (!Array.isArray(nodesRaw)) {
    throw new Error('data lineage graph nodes must be an array')
  }
  return {
    schemaVersion: requireString(raw.schema_version, 'schema_version'),
    generatedAt: requireString(raw.generated_at, 'generated_at'),
    nodes: nodesRaw.map((nodeRaw, index) => dataLineageNodeFromJson(nodeRaw, index)),
  }
}

function dataLineageNodeFromJson(value: unknown, index: number): DataLineageNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`data lineage node ${index} must be an object`)
  }
  const raw = value as Record<string, unknown>
  return {
    id: requireString(raw.id, `nodes[${index}].id`),
    type: requireNodeType(raw.type, `nodes[${index}].type`),
    qualityStatus: requireQualityStatus(raw.quality_status, `nodes[${index}].quality_status`),
    parents: readStringArray(raw.parents, `nodes[${index}].parents`),
    source: readNullableString(raw.source, `nodes[${index}].source`),
    endpoint: readNullableString(raw.endpoint, `nodes[${index}].endpoint`),
    symbol: readNullableString(raw.symbol, `nodes[${index}].symbol`),
    firstTimestamp: readNullableString(raw.first_timestamp, `nodes[${index}].first_timestamp`),
    lastTimestamp: readNullableString(raw.last_timestamp, `nodes[${index}].last_timestamp`),
    availableTimePolicy: readNullableString(raw.available_time_policy, `nodes[${index}].available_time_policy`),
    metadata: readMetadata(raw.metadata, `nodes[${index}].metadata`),
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`${field} must be a string or null`)
  return value
}

function readStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`)
  }
  return value
}

function readMetadata(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireNodeType(value: unknown, field: string): DataLineageNodeType {
  if (DATA_LINEAGE_NODE_TYPES.includes(value as DataLineageNodeType)) {
    return value as DataLineageNodeType
  }
  throw new Error(`${field} must be a supported data lineage node type`)
}

function requireQualityStatus(value: unknown, field: string): DataLineageQualityStatus {
  if (DATA_LINEAGE_QUALITY_STATUSES.includes(value as DataLineageQualityStatus)) {
    return value as DataLineageQualityStatus
  }
  throw new Error(`${field} must be a supported data lineage quality status`)
}

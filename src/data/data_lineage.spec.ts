import { describe, expect, it } from 'vitest'
import {
  DATA_LINEAGE_PIT_POLICY,
  DATA_LINEAGE_SCHEMA_VERSION,
  type DataLineageGraph,
  dataLineageGraphToJson,
  dataLineageGraphFromJson,
  hashDataLineageGraph,
  validateDataLineageGraph,
} from './data_lineage.js'

function makeValidGraph(): DataLineageGraph {
  return {
    schemaVersion: DATA_LINEAGE_SCHEMA_VERSION,
    generatedAt: '2026-05-02T00:00:00.000Z',
    nodes: [
      {
        id: 'binance_btcusdt_1m_raw',
        type: 'raw_source',
        qualityStatus: 'ok',
        source: 'binance',
        endpoint: '/api/v3/klines',
        symbol: 'BTCUSDT',
        firstTimestamp: '2026-05-01T00:00:00.000Z',
        lastTimestamp: '2026-05-02T00:00:00.000Z',
      },
      {
        id: 'btcusdt_1m_normalized',
        type: 'normalized_series',
        qualityStatus: 'ok',
        parents: ['binance_btcusdt_1m_raw'],
      },
      {
        id: 'btcusdt_1m_return_5',
        type: 'feature',
        qualityStatus: 'ok',
        parents: ['btcusdt_1m_normalized'],
        availableTimePolicy: DATA_LINEAGE_PIT_POLICY,
      },
      {
        id: 'btcusdt_strategy_input',
        type: 'strategy_input',
        qualityStatus: 'ok',
        parents: ['btcusdt_1m_return_5'],
        availableTimePolicy: DATA_LINEAGE_PIT_POLICY,
      },
      {
        id: 'btcusdt_decision_artifact',
        type: 'decision_artifact',
        qualityStatus: 'ok',
        parents: ['btcusdt_strategy_input'],
        availableTimePolicy: DATA_LINEAGE_PIT_POLICY,
      },
    ],
  }
}

describe('data_lineage', () => {
  it('validates and serializes a raw to normalized to feature graph', () => {
    const graph = makeValidGraph()

    expect(validateDataLineageGraph(graph)).toMatchObject({
      passed: true,
      blockingReasons: [],
    })
    expect(validateDataLineageGraph(graph).hash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(dataLineageGraphToJson(graph)).toEqual({
      schema_version: DATA_LINEAGE_SCHEMA_VERSION,
      generated_at: '2026-05-02T00:00:00.000Z',
      nodes: [
        {
          id: 'binance_btcusdt_1m_raw',
          type: 'raw_source',
          quality_status: 'ok',
          parents: [],
          source: 'binance',
          endpoint: '/api/v3/klines',
          symbol: 'BTCUSDT',
          first_timestamp: '2026-05-01T00:00:00.000Z',
          last_timestamp: '2026-05-02T00:00:00.000Z',
          available_time_policy: null,
          metadata: {},
        },
        {
          id: 'btcusdt_1m_normalized',
          type: 'normalized_series',
          quality_status: 'ok',
          parents: ['binance_btcusdt_1m_raw'],
          source: null,
          endpoint: null,
          symbol: null,
          first_timestamp: null,
          last_timestamp: null,
          available_time_policy: null,
          metadata: {},
        },
        {
          id: 'btcusdt_1m_return_5',
          type: 'feature',
          quality_status: 'ok',
          parents: ['btcusdt_1m_normalized'],
          source: null,
          endpoint: null,
          symbol: null,
          first_timestamp: null,
          last_timestamp: null,
          available_time_policy: DATA_LINEAGE_PIT_POLICY,
          metadata: {},
        },
        {
          id: 'btcusdt_strategy_input',
          type: 'strategy_input',
          quality_status: 'ok',
          parents: ['btcusdt_1m_return_5'],
          source: null,
          endpoint: null,
          symbol: null,
          first_timestamp: null,
          last_timestamp: null,
          available_time_policy: DATA_LINEAGE_PIT_POLICY,
          metadata: {},
        },
        {
          id: 'btcusdt_decision_artifact',
          type: 'decision_artifact',
          quality_status: 'ok',
          parents: ['btcusdt_strategy_input'],
          source: null,
          endpoint: null,
          symbol: null,
          first_timestamp: null,
          last_timestamp: null,
          available_time_policy: DATA_LINEAGE_PIT_POLICY,
          metadata: {},
        },
      ],
    })
  })

  it('hard-blocks unsupported schema versions and empty graphs', () => {
    const graph = makeValidGraph()
    graph.schemaVersion = 'data_lineage.v4_0'

    expect(validateDataLineageGraph(graph)).toMatchObject({
      passed: false,
      blockingReasons: [{
        code: 'DATA_LINEAGE_SCHEMA_VERSION_MISMATCH',
        required: DATA_LINEAGE_SCHEMA_VERSION,
        observed: 'data_lineage.v4_0',
      }],
    })

    expect(validateDataLineageGraph({
      schemaVersion: DATA_LINEAGE_SCHEMA_VERSION,
      generatedAt: '2026-05-02T00:00:00.000Z',
      nodes: [],
    })).toMatchObject({
      passed: false,
      blockingReasons: [{ code: 'DATA_LINEAGE_GRAPH_EMPTY' }],
    })
  })

  it('hard-blocks duplicate node ids', () => {
    const graph = makeValidGraph()
    graph.nodes.push({
      id: 'btcusdt_1m_return_5',
      type: 'feature',
      qualityStatus: 'ok',
      parents: ['btcusdt_1m_normalized'],
      availableTimePolicy: DATA_LINEAGE_PIT_POLICY,
    })

    expect(validateDataLineageGraph(graph)).toMatchObject({
      passed: false,
      blockingReasons: [{
        code: 'DUPLICATE_LINEAGE_NODE_ID',
        nodeId: 'btcusdt_1m_return_5',
      }],
    })
  })

  it('hard-blocks missing parents', () => {
    const graph = makeValidGraph()
    graph.nodes[1] = {
      ...graph.nodes[1],
      parents: ['missing_raw_source'],
    }

    expect(validateDataLineageGraph(graph)).toMatchObject({
      passed: false,
      blockingReasons: [{
        code: 'MISSING_LINEAGE_PARENT',
        nodeId: 'btcusdt_1m_normalized',
        parentId: 'missing_raw_source',
      }],
    })
  })

  it('hard-blocks feature nodes without a PIT available time policy', () => {
    const graph = makeValidGraph()
    graph.nodes[2] = {
      ...graph.nodes[2],
      availableTimePolicy: null,
    }

    expect(validateDataLineageGraph(graph)).toMatchObject({
      passed: false,
      blockingReasons: [{
        code: 'FEATURE_MISSING_AVAILABLE_TIME_POLICY',
        nodeId: 'btcusdt_1m_return_5',
      }],
    })
  })

  it('hard-blocks feature policies that do not include PIT decision-time ordering', () => {
    const graph = makeValidGraph()
    graph.nodes[2] = {
      ...graph.nodes[2],
      availableTimePolicy: 'available_time <= decision_time OR available_time > decision_time',
    }

    expect(validateDataLineageGraph(graph)).toMatchObject({
      passed: false,
      blockingReasons: [{
        code: 'FEATURE_NON_PIT_AVAILABLE_TIME_POLICY',
        nodeId: 'btcusdt_1m_return_5',
      }],
    })
  })

  it('hard-blocks non-ok quality statuses in the lineage graph', () => {
    const graph = makeValidGraph()
    graph.nodes[0] = {
      ...graph.nodes[0],
      qualityStatus: 'stale',
    }
    graph.nodes[2] = {
      ...graph.nodes[2],
      qualityStatus: 'observation_only',
    }
    graph.nodes[3] = {
      ...graph.nodes[3],
      qualityStatus: 'unknown_lineage',
    }
    graph.nodes[4] = {
      ...graph.nodes[4],
      qualityStatus: 'proxy_only',
    }

    expect(validateDataLineageGraph(graph)).toMatchObject({
      passed: false,
      blockingReasons: [
        {
          code: 'LINEAGE_NODE_QUALITY_STALE',
          nodeId: 'binance_btcusdt_1m_raw',
          qualityStatus: 'stale',
        },
        {
          code: 'LINEAGE_NODE_OBSERVATION_ONLY',
          nodeId: 'btcusdt_1m_return_5',
          qualityStatus: 'observation_only',
        },
        {
          code: 'LINEAGE_NODE_UNKNOWN_LINEAGE',
          nodeId: 'btcusdt_strategy_input',
          qualityStatus: 'unknown_lineage',
        },
        {
          code: 'LINEAGE_NODE_PROXY_ONLY',
          nodeId: 'btcusdt_decision_artifact',
          qualityStatus: 'proxy_only',
        },
      ],
    })
  })

  it('requires PIT policy on strategy inputs and decision artifacts', () => {
    const graph = makeValidGraph()
    graph.nodes[3] = {
      ...graph.nodes[3],
      availableTimePolicy: null,
    }
    graph.nodes[4] = {
      ...graph.nodes[4],
      availableTimePolicy: 'available_time <= decision_time OR available_time > decision_time',
    }

    expect(validateDataLineageGraph(graph)).toMatchObject({
      passed: false,
      blockingReasons: [
        {
          code: 'STRATEGY_INPUT_MISSING_AVAILABLE_TIME_POLICY',
          nodeId: 'btcusdt_strategy_input',
        },
        {
          code: 'DECISION_ARTIFACT_NON_PIT_AVAILABLE_TIME_POLICY',
          nodeId: 'btcusdt_decision_artifact',
        },
      ],
    })
  })

  it('parses persisted snake_case lineage graphs', () => {
    const graph = makeValidGraph()
    const parsed = dataLineageGraphFromJson(dataLineageGraphToJson(graph))

    expect(parsed).toMatchObject({
      schemaVersion: DATA_LINEAGE_SCHEMA_VERSION,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })
    expect(parsed.nodes[0]).toMatchObject({
        id: 'binance_btcusdt_1m_raw',
        qualityStatus: 'ok',
        source: 'binance',
    })
  })

  it('hashes data lineage graphs with stable key order', () => {
    const left = makeValidGraph()
    const right: DataLineageGraph = {
      nodes: [
        {
          qualityStatus: 'ok',
          type: 'raw_source',
          source: 'binance',
          endpoint: '/api/v3/klines',
          symbol: 'BTCUSDT',
          firstTimestamp: '2026-05-01T00:00:00.000Z',
          lastTimestamp: '2026-05-02T00:00:00.000Z',
          id: 'binance_btcusdt_1m_raw',
        },
        {
          parents: ['binance_btcusdt_1m_raw'],
          qualityStatus: 'ok',
          type: 'normalized_series',
          id: 'btcusdt_1m_normalized',
        },
        {
          availableTimePolicy: DATA_LINEAGE_PIT_POLICY,
          parents: ['btcusdt_1m_normalized'],
          qualityStatus: 'ok',
          type: 'feature',
          id: 'btcusdt_1m_return_5',
        },
        {
          availableTimePolicy: DATA_LINEAGE_PIT_POLICY,
          parents: ['btcusdt_1m_return_5'],
          qualityStatus: 'ok',
          type: 'strategy_input',
          id: 'btcusdt_strategy_input',
        },
        {
          availableTimePolicy: DATA_LINEAGE_PIT_POLICY,
          parents: ['btcusdt_strategy_input'],
          qualityStatus: 'ok',
          type: 'decision_artifact',
          id: 'btcusdt_decision_artifact',
        },
      ],
      generatedAt: '2026-05-03T00:00:00.000Z',
      schemaVersion: DATA_LINEAGE_SCHEMA_VERSION,
    }

    expect(hashDataLineageGraph(left)).toBe(hashDataLineageGraph(right))
    expect(hashDataLineageGraph(left)).toMatch(/^sha256:[a-f0-9]{64}$/)
  })
})

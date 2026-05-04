export interface CorrelationWindow {
  symbols: string[]
  correlation: number[][]
}

export interface StableClusterInput {
  windows: CorrelationWindow[]
  edgeCorrelationThreshold?: number
  consensusThreshold?: number
  representativeScores?: Record<string, number>
}

export interface StableCluster {
  clusterId: number
  symbols: string[]
  representative: string
}

export interface StableClusterResult {
  clusters: StableCluster[]
  coAssignmentFrequency: Record<string, number>
}

export function buildStableCorrelationClusters(input: StableClusterInput): StableClusterResult {
  const edgeThreshold = input.edgeCorrelationThreshold ?? 0.65
  const consensusThreshold = input.consensusThreshold ?? 0.6
  const symbols = collectSymbols(input.windows)
  const pairCounts = new Map<string, number>()
  const seenCounts = new Map<string, number>()

  for (const window of input.windows) {
    for (let i = 0; i < window.symbols.length; i += 1) {
      for (let j = i + 1; j < window.symbols.length; j += 1) {
        const key = pairKey(window.symbols[i], window.symbols[j])
        const correlation = window.correlation[i]?.[j]
        if (!Number.isFinite(correlation)) {
          continue
        }
        seenCounts.set(key, (seenCounts.get(key) ?? 0) + 1)
        if (Math.abs(correlation) >= edgeThreshold) {
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
        }
      }
    }
  }

  const adjacency = new Map(symbols.map((symbol) => [symbol, new Set<string>()]))
  const coAssignmentFrequency: Record<string, number> = {}
  for (const [key, seen] of seenCounts) {
    const frequency = seen > 0 ? (pairCounts.get(key) ?? 0) / seen : 0
    coAssignmentFrequency[key] = frequency
    if (frequency >= consensusThreshold) {
      const [left, right] = key.split('|')
      adjacency.get(left)?.add(right)
      adjacency.get(right)?.add(left)
    }
  }

  const clusters = connectedComponents(symbols, adjacency).map((component, index) => ({
    clusterId: index + 1,
    symbols: component,
    representative: selectRepresentative(component, input.representativeScores ?? {}),
  }))

  return { clusters, coAssignmentFrequency }
}

function collectSymbols(windows: CorrelationWindow[]): string[] {
  return Array.from(new Set(windows.flatMap((window) => window.symbols))).sort()
}

function connectedComponents(
  symbols: string[],
  adjacency: Map<string, Set<string>>,
): string[][] {
  const visited = new Set<string>()
  const out: string[][] = []
  for (const symbol of symbols) {
    if (visited.has(symbol)) {
      continue
    }
    const stack = [symbol]
    const component: string[] = []
    visited.add(symbol)
    while (stack.length > 0) {
      const current = stack.pop()!
      component.push(current)
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next)
          stack.push(next)
        }
      }
    }
    out.push(component.sort())
  }
  return out.sort((left, right) => left[0].localeCompare(right[0]))
}

function selectRepresentative(symbols: string[], scores: Record<string, number>): string {
  return [...symbols].sort((left, right) => {
    const scoreDiff = (scores[right] ?? 0) - (scores[left] ?? 0)
    return scoreDiff !== 0 ? scoreDiff : left.localeCompare(right)
  })[0]
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join('|')
}

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type ModuleMode = 'off' | 'shadow' | 'active'

export interface ExperimentRecord {
  experiment_id: string
  strategy: string
  git_commit: string
  data_range: {
    train: [string, string]
    test: [string, string]
  }
  config_hash: string
  metrics: {
    is_sharpe?: number
    oos_sharpe?: number
    oos_is_ratio?: number
    max_drawdown?: number
    turnover?: number
    cost_adjusted_score?: number | null
  }
  gates: {
    promotion: 'PASS' | 'FAIL' | 'NOT_EVALUATED'
    reason: string[]
  }
  module_modes: Record<string, ModuleMode>
}

const DEFAULT_DIR = 'data/research/experiments'

export function writeExperiment(
  record: ExperimentRecord,
  dir: string = DEFAULT_DIR,
): void {
  mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const path = join(dir, `${date}.jsonl`)
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8')
}

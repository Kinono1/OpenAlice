import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

export interface RunConfigMetadata {
  config_version: string
  config_hash: string
  git_commit: string
  data_version: string
  generated_at: string
}

export function hashConfig(config: unknown): string {
  const json = stableJsonStringify(config)
  return `sha256:${createHash('sha256').update(json).digest('hex').slice(0, 16)}`
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue)
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortJsonValue(record[key])]),
  )
}

export function getGitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

export function buildRunMetadata(
  configVersion: string,
  config: unknown,
  dataVersion: string,
): RunConfigMetadata {
  return {
    config_version: configVersion,
    config_hash: hashConfig(config),
    git_commit: getGitCommit(),
    data_version: dataVersion,
    generated_at: new Date().toISOString(),
  }
}

/**
 * Unified gate-status derivation helpers.
 *
 * Many `scripts/build_*_gate_status.ts` builders historically hardcoded
 * `status: 'pass'` as a literal regardless of check verdicts, causing
 * runtime artifacts to misreport check outcomes. This module centralises
 * the verdict → top-level status → evidence-manifest businessStatus mapping
 * so future builders can derive consistently.
 */

export type CheckVerdict =
  | 'ok'
  | 'pass'
  | 'needs_work'
  | 'fail'
  | 'warning'
  | 'unavailable'

export type TopLevelStatus = 'pass' | 'needs_work' | 'fail'

export type BusinessStatus = 'pass' | 'warn' | 'fail'

/**
 * Aggregate per-check verdicts into a single gate-level status.
 * Priority: any `fail` → fail; any `needs_work`/`warning`/`unavailable` →
 * needs_work; otherwise (all `ok`/`pass`) → pass.
 *
 * Empty input returns `pass` (no checks ⇒ no failures); callers that need
 * stricter semantics should validate input length themselves.
 */
export function deriveTopLevelStatus(verdicts: ReadonlyArray<CheckVerdict>): TopLevelStatus {
  if (verdicts.some((v) => v === 'fail')) return 'fail'
  if (
    verdicts.some(
      (v) => v === 'needs_work' || v === 'warning' || v === 'unavailable',
    )
  ) {
    return 'needs_work'
  }
  return 'pass'
}

/**
 * Map top-level gate status to evidence-manifest businessStatus vocabulary.
 * `pass` → `pass`, `needs_work` → `warn`, `fail` → `fail`.
 */
export function mapToBusinessStatus(top: TopLevelStatus): BusinessStatus {
  if (top === 'fail') return 'fail'
  if (top === 'needs_work') return 'warn'
  return 'pass'
}

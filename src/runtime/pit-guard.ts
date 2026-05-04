export interface TimedFactorValue {
  symbol: string
  factor: string
  value: number
  event_time: string       // ISO 8601 (K线 close time)
  available_time: string   // ISO 8601 (when data became available to system)
  source?: string
}

export class PITViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PITViolationError'
  }
}

/**
 * Runtime PIT guard — asserts no future data has leaked into features.
 * Called before features enter the model. Not just a test assertion —
 * this is the production defense against data pipeline join/resample bugs.
 */
export function assertPIT(features: TimedFactorValue[], decisionTime: Date): void {
  for (const f of features) {
    const avail = new Date(f.available_time)
    if (isNaN(avail.getTime())) {
      throw new PITViolationError(
        `PIT: ${f.factor} has invalid available_time: "${f.available_time}"`
      )
    }
    if (avail > decisionTime) {
      throw new PITViolationError(
        `FUTURE LEAK: ${f.factor} available at ${f.available_time} ` +
        `but decision at ${decisionTime.toISOString()}`
      )
    }
  }
}

/**
 * Compute dynamic embargo = sum of sequential lags (not max).
 * These are serial delays, not parallel:
 *   event → +feature_lag → +forward_horizon → +execution_lag
 */
export function computeEmbargo(
  forwardHorizonHours: number,
  featureAvailabilityLagHours: number,
  executionLagHours: number,
): number {
  return forwardHorizonHours + featureAvailabilityLagHours + executionLagHours
}

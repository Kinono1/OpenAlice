import type {
  ActiveFreezeWindow,
  FreezeEvaluation,
  MacroEvent,
} from './types.js'

export function getActiveFreezeWindows(
  nowUtcMs: number,
  marketScope: 'crypto' | 'a-share',
  events: MacroEvent[],
): ActiveFreezeWindow[] {
  return events
    .filter((event) => event.marketScope.includes(marketScope))
    .map((event) => {
      const startsAtUtc = event.releaseTimeUtc - event.freezeRule.preFreezeHours * 3600_000
      const endsAtUtc = event.releaseTimeUtc + event.freezeRule.postFreezeHours * 3600_000
      return {
        event,
        startsAtUtc,
        endsAtUtc,
      }
    })
    .filter((window) => nowUtcMs >= window.startsAtUtc && nowUtcMs <= window.endsAtUtc)
    .sort((left, right) => {
      const severityRank = { high: 0, medium: 1, low: 2 }
      return severityRank[left.event.severity] - severityRank[right.event.severity]
    })
}

export function evaluateFreezeWindows(
  nowUtcMs: number,
  marketScope: 'crypto' | 'a-share',
  events: MacroEvent[],
): FreezeEvaluation {
  const activeWindows = getActiveFreezeWindows(nowUtcMs, marketScope, events)
  const highestPriority = activeWindows[0]
  return {
    active: activeWindows.length > 0,
    marketScope,
    maxActionDuringFreeze: highestPriority?.event.freezeRule.maxActionDuringFreeze,
    activeWindows,
  }
}

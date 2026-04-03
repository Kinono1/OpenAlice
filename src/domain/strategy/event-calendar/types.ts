import type { ActionStatus } from '../governance/types.js'

export interface FreezeRule {
  preFreezeHours: number
  postFreezeHours: number
  maxActionDuringFreeze: Extract<ActionStatus, 'reduce' | 'exit' | 'no-trade' | 'hold'>
}

export interface MacroEvent {
  name: string
  releaseTimeUtc: number
  severity: 'high' | 'medium' | 'low'
  marketScope: Array<'crypto' | 'a-share'>
  freezeRule: FreezeRule
}

export interface ActiveFreezeWindow {
  event: MacroEvent
  startsAtUtc: number
  endsAtUtc: number
}

export interface FreezeEvaluation {
  active: boolean
  marketScope: 'crypto' | 'a-share'
  maxActionDuringFreeze?: FreezeRule['maxActionDuringFreeze']
  activeWindows: ActiveFreezeWindow[]
}

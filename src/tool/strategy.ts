import { tool } from 'ai'
import { z } from 'zod'
import { evaluateFreezeWindows } from '../domain/strategy/event-calendar/index.js'
import { evaluateSignalGovernance } from '../domain/strategy/governance/index.js'
import {
  combineFactorSignalsWithGovernance,
  evaluateBasisFactor,
  evaluateFundingRateFactor,
  evaluateMomentumComposite,
  evaluateVolumeSurgeFactor,
} from '../domain/strategy/factors/index.js'
import {
  evaluateLayerLimits,
  fractionalKelly,
  volatilityTargetSize,
} from '../domain/strategy/position-sizing/index.js'
import { evaluateRegime, evaluateRegimeTransition } from '../domain/strategy/regime/index.js'
import { summarizeReviewRecords } from '../domain/strategy/review/index.js'
import { validateExecutionTicket } from '../domain/strategy/ticket-lifecycle/index.js'
import { evaluateRuntimeStrategySnapshotFromSources } from '../domain/strategy/runtime-service.js'
import type { UTAManager } from '../domain/trading/uta-manager.js'
import type { CryptoClientLike } from '../domain/market-data/client/types'

export function createStrategyTools(
  utaManager?: UTAManager,
  cryptoClient?: CryptoClientLike,
) {
  return {
    scoreStrategySignal: tool({
      description: 'Score a strategy signal using L/U/D/S governance and map it to an action status.',
      inputSchema: z.object({
        sourceTier: z.enum(['L1', 'L2', 'L3', 'L4', 'L5']),
        useType: z.enum(['U1', 'U2', 'U3', 'U4']),
        decisionStrength: z.enum(['D1', 'D2', 'D3', 'D4', 'D5']),
        sentiment: z.enum(['S+2', 'S+1', 'S0', 'S-1', 'S-2']),
        staleData: z.boolean().optional(),
        eventWindowFrozen: z.boolean().optional(),
        eventSeverity: z.enum(['high', 'medium', 'low', 'none']).optional(),
        maxActionDuringFreeze: z.enum(['reduce', 'exit', 'no-trade', 'hold']).optional(),
      }),
      execute: async (input) => {
        return evaluateSignalGovernance(
          {
            sourceTier: input.sourceTier,
            useType: input.useType,
            decisionStrength: input.decisionStrength,
            sentiment: input.sentiment,
          },
          {
            staleData: input.staleData,
            eventWindowFrozen: input.eventWindowFrozen,
            eventSeverity: input.eventSeverity,
            maxActionDuringFreeze: input.maxActionDuringFreeze,
          },
        )
      },
    }),

    evaluateMacroFreezeWindow: tool({
      description: 'Evaluate whether the current time is inside any macro-event freeze window for a market scope.',
      inputSchema: z.object({
        nowUtcMs: z.number().int().optional(),
        marketScope: z.enum(['crypto', 'a-share']),
        events: z.array(
          z.object({
            name: z.string(),
            releaseTimeUtc: z.number().int(),
            severity: z.enum(['high', 'medium', 'low']),
            marketScope: z.array(z.enum(['crypto', 'a-share'])),
            freezeRule: z.object({
              preFreezeHours: z.number(),
              postFreezeHours: z.number(),
              maxActionDuringFreeze: z.enum(['reduce', 'exit', 'no-trade', 'hold']),
            }),
          }),
        ),
      }),
      execute: async ({ nowUtcMs, marketScope, events }) => {
        return evaluateFreezeWindows(nowUtcMs ?? Date.now(), marketScope, events)
      },
    }),

    evaluateFundingRateFactor: tool({
      description: 'Evaluate a funding-rate factor signal using current and rolling funding statistics.',
      inputSchema: z.object({
        currentFundingRatePct: z.number(),
        rollingMeanPct: z.number(),
        rollingStdPct: z.number().positive(),
      }),
      execute: async (input) => evaluateFundingRateFactor(input),
    }),

    evaluateBasisFactor: tool({
      description: 'Evaluate a basis factor signal from futures and spot prices.',
      inputSchema: z.object({
        futuresPrice: z.number().positive(),
        spotPrice: z.number().positive(),
        daysToExpiry: z.number().positive().optional(),
        rollingMeanPct: z.number().optional(),
        rollingStdPct: z.number().positive().optional(),
      }),
      execute: async (input) => evaluateBasisFactor(input),
    }),

    evaluateVolumeSurgeFactor: tool({
      description: 'Evaluate a volume-surge factor signal from current/average volume and recent price return.',
      inputSchema: z.object({
        currentVolume: z.number().nonnegative(),
        averageVolume: z.number().nonnegative(),
        priceReturnPct: z.number(),
      }),
      execute: async (input) => evaluateVolumeSurgeFactor(input),
    }),

    evaluateMomentumCompositeFactor: tool({
      description: 'Evaluate a multi-horizon momentum composite factor signal.',
      inputSchema: z.object({
        return1hPct: z.number(),
        return6hPct: z.number(),
        return24hPct: z.number(),
        return7dPct: z.number(),
        realizedVolPct: z.number().nonnegative().optional(),
      }),
      execute: async (input) => evaluateMomentumComposite(input),
    }),

    scoreFactorEnsemble: tool({
      description: 'Combine factor signals and project the ensemble into the governance action gate.',
      inputSchema: z.object({
        sourceTier: z.enum(['L1', 'L2', 'L3', 'L4', 'L5']),
        useType: z.enum(['U1', 'U2', 'U3', 'U4']),
        sentiment: z.enum(['S+2', 'S+1', 'S0', 'S-1', 'S-2']),
        signals: z.array(
          z.object({
            name: z.string(),
            value: z.number(),
            confidence: z.number(),
            sourceTier: z.enum(['L1', 'L2', 'L3', 'L4', 'L5']),
            decisionStrength: z.enum(['D1', 'D2', 'D3', 'D4', 'D5']),
            metadata: z.record(z.string(), z.number()),
          }),
        ),
      }),
      execute: async ({ sourceTier, useType, sentiment, signals }) => {
        return combineFactorSignalsWithGovernance(signals, {
          sourceTier,
          useType,
          sentiment,
        })
      },
    }),

    evaluateFractionalKelly: tool({
      description: 'Compute a fractional Kelly position size.',
      inputSchema: z.object({
        winRate: z.number(),
        avgWinLossRatio: z.number().positive(),
        fraction: z.number().positive().optional(),
      }),
      execute: async ({ winRate, avgWinLossRatio, fraction }) =>
        fractionalKelly(winRate, avgWinLossRatio, fraction),
    }),

    evaluateVolatilityTargetSize: tool({
      description: 'Compute a volatility-targeted position size.',
      inputSchema: z.object({
        targetVolPct: z.number().positive(),
        currentVolPct: z.number().positive(),
        maxPct: z.number().positive().optional(),
      }),
      execute: async ({ targetVolPct, currentVolPct, maxPct }) =>
        volatilityTargetSize(targetVolPct, currentVolPct, maxPct),
    }),

    evaluateLayerLimits: tool({
      description: 'Evaluate strategy layer-based position limits and trade eligibility.',
      inputSchema: z.object({
        config: z.object({
          layer: z.enum(['core', 'extended', 'watch-only']),
          maxPositions: z.number().int().nonnegative(),
          maxPositionPctOfEquity: z.number().nonnegative(),
          minActionStatusToTrade: z.enum(['attack', 'attack-lite', 'probe', 'hold', 'reduce', 'exit', 'no-trade']),
          requiresCoreNotRiskOff: z.boolean(),
        }),
        context: z.object({
          actionStatus: z.enum(['attack', 'attack-lite', 'probe', 'hold', 'reduce', 'exit', 'no-trade']),
          assetLayer: z.enum(['core', 'extended', 'watch-only']),
          currentOpenPositions: z.number().int().nonnegative(),
          currentLayerOpenPositions: z.number().int().nonnegative(),
          equity: z.number().nonnegative(),
          coreRiskOff: z.boolean().optional(),
        }),
        requestedPctOfEquity: z.number().nonnegative(),
        method: z.enum(['fixed', 'kelly', 'volTarget']),
      }),
      execute: async ({ config, context, requestedPctOfEquity, method }) =>
        evaluateLayerLimits(config, context, requestedPctOfEquity, method),
    }),

    evaluateRegime: tool({
      description: 'Classify the current market regime from normalized strategy features.',
      inputSchema: z.object({
        trendStrength: z.number(),
        realizedVolPct: z.number().nonnegative(),
        rangeCompressionScore: z.number(),
        eventWindowFrozen: z.boolean().optional(),
      }),
      execute: async (input) => evaluateRegime(input),
    }),

    evaluateRegimeTransition: tool({
      description: 'Evaluate what should happen to existing tickets when market regime changes.',
      inputSchema: z.object({
        previous: z.enum(['spot-defensive', 'range-rotation', 'trend-follow', 'event-risk-freeze']),
        next: z.enum(['spot-defensive', 'range-rotation', 'trend-follow', 'event-risk-freeze']),
      }),
      execute: async ({ previous, next }) => evaluateRegimeTransition(previous, next),
    }),

    summarizeStrategyReviews: tool({
      description: 'Summarize review labels into promoted candidates and hard restrictions.',
      inputSchema: z.object({
        records: z.array(
          z.object({
            ticketId: z.string(),
            label: z.enum(['alpha-valid', 'timing-bad', 'execution-bad', 'sentiment-trap', 'regime-miss', 'should-not-trade']),
            strategyId: z.string().optional(),
            notes: z.string().optional(),
          }),
        ),
      }),
      execute: async ({ records }) => summarizeReviewRecords(records),
    }),

    validateExecutionTicket: tool({
      description: 'Validate whether an execution ticket is complete enough to enter the active lifecycle state.',
      inputSchema: z.object({
        ticket: z.object({
          ticketId: z.string(),
          market: z.string(),
          venue: z.string(),
          instrument: z.string(),
          productType: z.enum(['SPOT', 'SWAP']),
          direction: z.enum(['BUY', 'SELL']),
          orderType: z.enum(['market', 'limit']),
          entryPrice: z.number().positive(),
          size: z.number().positive(),
          tp: z.number().optional(),
          sl: z.number().optional(),
          leverage: z.number().optional(),
          riskIfFilled: z.number().nonnegative(),
          generatedAt: z.number().int(),
          expiresAt: z.number().int().optional(),
          cancelIf: z.string().optional(),
          invalidateRule: z.string().optional(),
          priorityRank: z.number().int(),
          assetLayer: z.enum(['core', 'extended', 'watch-only']),
          status: z.enum(['candidate', 'active', 'replaced', 'expired', 'invalidated', 'executed', 'cancelled']),
          latestReferencePrice: z.number().optional(),
        }),
        activeTickets: z.array(z.any()).optional(),
      }),
      execute: async ({ ticket, activeTickets }) =>
        validateExecutionTicket(ticket, activeTickets ?? []),
    }),

    evaluateRuntimeStrategySnapshot: tool({
      description: 'Build a live strategy factor snapshot from crypto historical data and optional CCXT funding rate.',
      inputSchema: z.object({
        symbol: z.string(),
        interval: z.string().default('1h'),
        source: z.string().optional(),
        sourceTier: z.enum(['L1', 'L2', 'L3', 'L4', 'L5']).default('L2'),
        useType: z.enum(['U1', 'U2', 'U3', 'U4']).default('U1'),
        sentiment: z.enum(['S+2', 'S+1', 'S0', 'S-1', 'S-2']).default('S0'),
        fundingRatePct: z.number().optional(),
        basisInput: z.object({
          futuresPrice: z.number().positive(),
          spotPrice: z.number().positive(),
          daysToExpiry: z.number().positive().optional(),
        }).optional(),
      }),
      execute: async ({
        symbol,
        interval,
        source,
        sourceTier,
        useType,
        sentiment,
        fundingRatePct,
        basisInput,
      }) => {
        if (!cryptoClient) {
          throw new Error('Crypto client is not configured for strategy runtime evaluation.')
        }

        return evaluateRuntimeStrategySnapshotFromSources({
          utaManager,
          cryptoClient,
          request: {
            symbol,
            interval,
            source,
            sourceTier,
            useType,
            sentiment,
            fundingRatePct,
            basisInput,
          },
        })
      },
    }),
  }
}

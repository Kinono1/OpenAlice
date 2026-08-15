import type {
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
  ICryptoTradingEngine,
} from './operation-dispatcher.types.js'
import type { BrokerWriteAuthorizationContext } from './operation-dispatcher.execution-gate.js'

/** The only supported routes for state-changing broker operations. */
export type BrokerWriteRoute = 'native' | 'sidecar'

export const SIDECAR_UNVERIFIED_BROKER_FINAL =
  'execution_sidecar_unverified_broker_final'

/**
 * A writer reports what is known about broker completion.  Acceptance by a
 * command transport is deliberately not treated as a completed broker write.
 */
export type BrokerWriteOutcome<T> =
  | {
      /** Valid only for the in-process native route; sidecar callers must reject it. */
      kind: 'broker_final'
      result: T
    }
  | {
      /** The writer proved that no transport or broker mutation was attempted. */
      kind: 'pre_submit_rejected'
      error: string
    }
  | {
      kind: 'command_accepted'
      commandId: string
      permitV2Id?: string
      acceptedSequence?: string
      clientOrderId?: string
      message?: string
    }
  | {
      kind: 'submission_unknown'
      error: string
      commandId?: string
      permitV2Id?: string
      clientOrderId?: string
    }

export interface AuthorizedBrokerWriter {
  placeOrder(
    request: CryptoPlaceOrderRequest,
    authorization: BrokerWriteAuthorizationContext,
  ): Promise<BrokerWriteOutcome<CryptoOrderResult>>
  cancelOrder(
    orderId: string,
    authorization: BrokerWriteAuthorizationContext,
  ): Promise<BrokerWriteOutcome<boolean>>
  adjustLeverage(
    symbol: string,
    newLeverage: number,
    authorization: BrokerWriteAuthorizationContext,
  ): Promise<BrokerWriteOutcome<{ success: boolean; error?: string }>>
}

const constrainedSidecarWriters = new WeakMap<
  AuthorizedBrokerWriter,
  AuthorizedBrokerWriter
>()

/**
 * A sidecar response cannot establish broker terminal state without a separate
 * authenticated broker-source receipt.  Normalize a custom or compromised
 * writer's unproven terminal claim to submission-unknown before any caller can
 * finalize idempotency from it.
 */
export function constrainBrokerWriteOutcomeToRoute<T>(
  route: BrokerWriteRoute,
  outcome: BrokerWriteOutcome<T>,
): BrokerWriteOutcome<T> {
  if (route === 'sidecar' && outcome.kind === 'broker_final') {
    return {
      kind: 'submission_unknown',
      error: SIDECAR_UNVERIFIED_BROKER_FINAL,
    }
  }
  return outcome
}

/**
 * Resolves exactly once at dispatcher construction.  In particular, a
 * sidecar selection never falls back to native engine mutation.
 */
export function resolveAuthorizedBrokerWriter(
  engine: ICryptoTradingEngine,
  input: { route?: BrokerWriteRoute; writer?: AuthorizedBrokerWriter },
): { route: BrokerWriteRoute; writer: AuthorizedBrokerWriter } {
  const route = input.route
  if (route === undefined) {
    if (input.writer) {
      throw new Error('broker_write_custom_writer_requires_explicit_sidecar_route')
    }
    return { route: 'native', writer: createNativeBrokerWriter(engine) }
  }
  if (route !== 'native' && route !== 'sidecar') {
    throw new Error('broker_write_route_invalid')
  }
  if (route === 'sidecar') {
    if (!input.writer) {
      throw new Error('broker_write_sidecar_writer_missing')
    }
    return { route, writer: createSidecarConstrainedBrokerWriter(input.writer) }
  }
  if (input.writer) {
    throw new Error('broker_write_custom_writer_requires_sidecar_route')
  }
  return { route: 'native', writer: createNativeBrokerWriter(engine) }
}

function createSidecarConstrainedBrokerWriter(
  writer: AuthorizedBrokerWriter,
): AuthorizedBrokerWriter {
  const existing = constrainedSidecarWriters.get(writer)
  if (existing) return existing
  const constrained: AuthorizedBrokerWriter = {
    async placeOrder(request, authorization) {
      return constrainBrokerWriteOutcomeToRoute(
        'sidecar',
        await writer.placeOrder(request, authorization),
      )
    },
    async cancelOrder(orderId, authorization) {
      return constrainBrokerWriteOutcomeToRoute(
        'sidecar',
        await writer.cancelOrder(orderId, authorization),
      )
    },
    async adjustLeverage(symbol, newLeverage, authorization) {
      return constrainBrokerWriteOutcomeToRoute(
        'sidecar',
        await writer.adjustLeverage(symbol, newLeverage, authorization),
      )
    },
  }
  constrainedSidecarWriters.set(writer, constrained)
  return constrained
}

/** The native route is a thin, one-call wrapper around the existing engine. */
export function createNativeBrokerWriter(
  engine: ICryptoTradingEngine,
): AuthorizedBrokerWriter {
  return {
    async placeOrder(request, _authorization) {
      return { kind: 'broker_final', result: await engine.placeOrder(request) }
    },
    async cancelOrder(orderId, _authorization) {
      return { kind: 'broker_final', result: await engine.cancelOrder(orderId) }
    },
    async adjustLeverage(symbol, newLeverage, _authorization) {
      return {
        kind: 'broker_final',
        result: await engine.adjustLeverage(symbol, newLeverage),
      }
    },
  }
}

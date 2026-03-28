/**
 * Guard Pipeline
 *
 * The only place that touches the engine: assembles a GuardContext,
 * then passes it through the guard chain. Guards themselves never
 * see the engine.
 */

import type { Operation } from '../wallet/types.js';
import type { ICryptoTradingEngine } from '../interfaces.js';
import type { OperationGuard, GuardContext } from './types.js';

export function createGuardPipeline(
  dispatcher: (op: Operation) => Promise<unknown>,
  engine: ICryptoTradingEngine,
  guards: OperationGuard[],
): (op: Operation) => Promise<unknown> {
  if (guards.length === 0) return dispatcher;

  return async (op: Operation): Promise<unknown> => {
    const [positions, account] = await Promise.all([
      engine.getPositions(),
      engine.getAccount(),
    ]);

    const ctx: GuardContext = { operation: op, positions, account };

    for (const guard of guards) {
      const rejection = await guard.check(ctx);
      if (rejection != null) {
        return { success: false, error: `[guard:${guard.name}] ${rejection}` };
      }
    }

    return dispatcher(op);
  };
}

export function createGuardBatchPipeline(
  dispatcher: (op: Operation) => Promise<unknown>,
  engine: ICryptoTradingEngine,
  guards: OperationGuard[],
): (operations: Operation[]) => Promise<unknown[]> {
  return async (operations: Operation[]): Promise<unknown[]> => {
    const results: unknown[] = [];
    let stopped = false;

    for (const op of operations) {
      if (stopped) {
        results.push({
          success: false,
          error: 'Skipped due to previous batch failure',
        });
        continue;
      }

      if (guards.length > 0) {
        const [positions, account] = await Promise.all([
          engine.getPositions(),
          engine.getAccount(),
        ]);

        const ctx: GuardContext = { operation: op, positions, account };
        let rejection: string | null = null;
        let rejectedBy: string | null = null;
        for (const guard of guards) {
          const guardResult = await guard.check(ctx);
          if (guardResult != null) {
            rejection = guardResult;
            rejectedBy = guard.name;
            break;
          }
        }

        if (rejection && rejectedBy) {
          results.push({
            success: false,
            error: `[guard:${rejectedBy}] ${rejection}`,
          });
          stopped = true;
          continue;
        }
      }

      try {
        const raw = await dispatcher(op);
        results.push(raw);
        if (!isRawSuccess(raw)) {
          stopped = true;
        }
      } catch (error) {
        results.push({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        stopped = true;
      }
    }

    return results;
  };
}

function isRawSuccess(raw: unknown): boolean {
  return Boolean(
    raw &&
      typeof raw === 'object' &&
      'success' in raw &&
      (raw as { success?: unknown }).success === true,
  );
}

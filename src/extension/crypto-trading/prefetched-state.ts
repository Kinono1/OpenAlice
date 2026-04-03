import type { Operation } from "./wallet/types.js";
import type { RiskCheckContext } from "./risk.js";

const PREFETCHED_RISK_STATE = Symbol("prefetched-risk-state");

type PrefetchedRiskState = Pick<RiskCheckContext, "positions" | "account">;

type OperationWithPrefetchedRiskState = Operation & {
  [PREFETCHED_RISK_STATE]?: PrefetchedRiskState;
};

function definePrefetchedRiskState(
  op: Operation,
  state: PrefetchedRiskState
): Operation {
  Object.defineProperty(op, PREFETCHED_RISK_STATE, {
    value: state,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return op;
}

export function cloneOperationWithPrefetchedRiskState(
  op: Operation,
  params: Operation["params"],
  state?: PrefetchedRiskState
): Operation {
  const nextOp: Operation = {
    action: op.action,
    params: { ...params },
  };
  const inheritedState = getPrefetchedRiskState(op);
  if (state) {
    return definePrefetchedRiskState(nextOp, state);
  }
  if (inheritedState) {
    return definePrefetchedRiskState(nextOp, inheritedState);
  }
  return nextOp;
}

export function getPrefetchedRiskState(
  op: Operation
): PrefetchedRiskState | undefined {
  return (op as OperationWithPrefetchedRiskState)[PREFETCHED_RISK_STATE];
}

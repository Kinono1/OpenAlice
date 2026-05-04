import type {
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
} from "../domain/trading/operation-dispatcher.types.js";
import type { OrderExecutionRecord } from "../live/execution_quality.js";

export function estimateRequestedNotionalUsd(
  req: CryptoPlaceOrderRequest,
  expectedPrice?: number,
): number | null {
  if (typeof req.usd_size === "number" && Number.isFinite(req.usd_size) && req.usd_size > 0) {
    return req.usd_size;
  }

  const size = req.size;
  const price = expectedPrice ?? req.price;
  if (
    typeof size === "number" &&
    Number.isFinite(size) &&
    size > 0 &&
    typeof price === "number" &&
    Number.isFinite(price) &&
    price > 0
  ) {
    return size * price;
  }

  return null;
}

export function buildExecutionRecord(
  req: CryptoPlaceOrderRequest,
  result: CryptoOrderResult,
  expectedPrice?: number,
  nowMs = Date.now()
): OrderExecutionRecord | null {
  if (!result.success) {
    return null;
  }

  const fallbackPriceRaw = expectedPrice ?? req.price ?? result.filledPrice;
  if (
    typeof fallbackPriceRaw !== "number" ||
    !Number.isFinite(fallbackPriceRaw) ||
    fallbackPriceRaw <= 0
  ) {
    return null;
  }
  const fallbackPrice = fallbackPriceRaw;

  const filledPrice = result.filledPrice ?? fallbackPrice;
  const requestedQty =
    (typeof result.requestedSize === "number" && result.requestedSize > 0
      ? result.requestedSize
      : undefined) ??
    (req.size && req.size > 0
      ? req.size
      : req.usd_size && req.usd_size > 0
        ? req.usd_size / fallbackPrice
        : result.filledSize ?? 0);
  const filledQty = result.filledSize ?? requestedQty;

  if (!(filledQty > 0) || !(requestedQty > 0)) {
    return null;
  }

  const firstFillAtMs =
    typeof result.firstFillAtMs === "number" ? result.firstFillAtMs : nowMs;
  const completedAtMs =
    typeof result.completedAtMs === "number" ? result.completedAtMs : null;
  const exchangeUpdateTs =
    typeof result.exchangeUpdateTs === "number"
      ? result.exchangeUpdateTs
      : nowMs;

  return {
    orderId:
      result.orderId ??
      `order_${nowMs}_${Math.floor(Math.random() * 1_000_000)}`,
    symbol: req.symbol,
    side: req.side,
    expectedPrice: fallbackPrice,
    actualPrice: filledPrice,
    requestedQty,
    filledQty,
    submittedAtMs: Math.min(nowMs, firstFillAtMs, exchangeUpdateTs),
    firstFillAtMs,
    completedAtMs,
  };
}

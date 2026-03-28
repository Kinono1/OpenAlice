import { z } from "zod";
import type { LiveMarketDataBar } from "./live_gate_manager.js";
import { evaluateDataContract } from "./data_contract.js";

const STRICT_UTC_ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const isoUtcSchema = z
  .string()
  .regex(STRICT_UTC_ISO_8601, "must be a strict ISO-8601 UTC timestamp");

const marketBarSchema = z
  .object({
    symbol: z.string().min(1),
    time: z.number().int().nonnegative(),
    open: z.number().positive(),
    high: z.number().positive(),
    low: z.number().positive(),
    close: z.number().positive(),
    volume: z.number().nonnegative(),
    tsOpenMs: z.number().int().nonnegative(),
    barIntervalMs: z.number().int().positive(),
    barCloseMs: z.number().int().nonnegative(),
    completed: z.boolean(),
    sourceDomain: z.string().min(1),
    instId: z.string().min(1).optional(),
    ccxtSymbol: z.string().min(1).optional(),
    clockSkewMs: z.number().optional(),
  })
  .strict();

export const marketContextV1Schema = z
  .object({
    schemaVersion: z.literal("market_context.v1"),
    generatedAt: isoUtcSchema,
    symbol: z.string().min(1),
    interval: z.string().min(1),
    lookbackBars: z.number().int().positive(),
    playheadTime: isoUtcSchema,
    availableSymbols: z.array(z.string().min(1)).min(1),
    source: z
      .object({
        provider: z.string().min(1),
        mode: z.enum(["native", "sidecar"]),
      })
      .strict(),
    bars: z.array(marketBarSchema).min(1),
  })
  .strict();

export type MarketContextV1 = z.infer<typeof marketContextV1Schema>;

export interface ContractValidationResult<T> {
  valid: boolean;
  blockingReasons: string[];
  value?: T;
}

export interface BuildMarketContextV1Input {
  generatedAt?: string;
  symbol: string;
  interval: string;
  lookbackBars: number;
  playheadTime: string | Date;
  availableSymbols: string[];
  provider: string;
  mode?: "native" | "sidecar";
  bars: LiveMarketDataBar[];
}

function toBlockingReasons(
  prefix: string,
  issues: readonly z.ZodIssue[],
): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${prefix}:${path}:${issue.message}`;
  });
}

function normalizeBar(bar: LiveMarketDataBar): z.infer<typeof marketBarSchema> {
  const tsOpenMs = bar.tsOpenMs ?? bar.time * 1000;
  const barIntervalMs = bar.barIntervalMs ?? 0;
  const barCloseMs = bar.barCloseMs ?? tsOpenMs + barIntervalMs;
  return {
    symbol: bar.symbol,
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    tsOpenMs,
    barIntervalMs,
    barCloseMs,
    completed: bar.completed === true,
    sourceDomain: bar.sourceDomain ?? "unknown",
    instId: bar.instId,
    ccxtSymbol: bar.ccxtSymbol,
    clockSkewMs: bar.clockSkewMs,
  };
}

export function validateMarketContextV1(
  payload: unknown,
): ContractValidationResult<MarketContextV1> {
  const parsed = marketContextV1Schema.safeParse(payload);
  if (!parsed.success) {
    return {
      valid: false,
      blockingReasons: toBlockingReasons(
        "market_context_schema_invalid",
        parsed.error.issues,
      ),
    };
  }

  const value = parsed.data;
  const contract = evaluateDataContract(
    value.bars.map((bar) => ({ ...bar })),
    {
      barIntervalMs: value.bars[0].barIntervalMs,
    },
  );
  if (!contract.dataQualityValid) {
    return {
      valid: false,
      blockingReasons: contract.blockingReasons.map(
        (reason) => `market_context_data_contract_failed:${reason}`,
      ),
      value,
    };
  }

  return {
    valid: true,
    blockingReasons: [],
    value,
  };
}

export function buildMarketContextV1(
  input: BuildMarketContextV1Input,
): MarketContextV1 {
  const payload: MarketContextV1 = {
    schemaVersion: "market_context.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    symbol: input.symbol,
    interval: input.interval,
    lookbackBars: input.lookbackBars,
    playheadTime:
      input.playheadTime instanceof Date
        ? input.playheadTime.toISOString()
        : input.playheadTime,
    availableSymbols: [...input.availableSymbols],
    source: {
      provider: input.provider,
      mode: input.mode ?? "native",
    },
    bars: input.bars
      .map(normalizeBar)
      .sort((a, b) => a.tsOpenMs - b.tsOpenMs),
  };

  const validation = validateMarketContextV1(payload);
  if (!validation.valid || !validation.value) {
    throw new Error(validation.blockingReasons.join("; "));
  }
  return validation.value;
}

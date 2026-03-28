import type { OpenBBCryptoClient } from "../openbb/crypto/index.js";
import type {
  LiveMarketContext,
  LiveMarketDataBar,
} from "./live_gate_manager.js";

interface OpenBBCryptoLiveMarketContextOptions {
  client: OpenBBCryptoClient;
  symbols: string[];
  interval?: string;
  now?: () => Date;
}

interface OpenBBHistoricalRow {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number | null;
  [key: string]: unknown;
}

export function createOpenBBCryptoLiveMarketContext(
  opts: OpenBBCryptoLiveMarketContextOptions
): LiveMarketContext {
  const interval = opts.interval ?? "1h";
  const now = opts.now ?? (() => new Date());
  const barMs = intervalToMs(interval);

  const loadRows = async (
    startTime: Date,
    endTime: Date,
    symbol: string
  ): Promise<LiveMarketDataBar[]> => {
    const query = {
      start_date: startTime.toISOString().slice(0, 10),
      end_date: endTime.toISOString().slice(0, 10),
      interval,
    };
    let rawRows: OpenBBHistoricalRow[] = [];
    let lastError: unknown;
    for (const candidate of buildHistoricalSymbolCandidates(symbol)) {
      try {
        rawRows = (await opts.client.getHistorical({
          symbol: candidate,
          ...query,
        })) as OpenBBHistoricalRow[];
      } catch (error) {
        lastError = error;
        continue;
      }
      if (rawRows.length > 0) {
        break;
      }
    }
    if (rawRows.length === 0 && lastError) {
      throw lastError;
    }

    return rawRows
      .map((row) => normalizeHistoricalRow(symbol, row, barMs))
      .filter((row): row is LiveMarketDataBar => row !== null)
      .filter((row) => (row.tsOpenMs ?? row.time * 1000) % barMs === 0)
      .filter((row) => {
        const tsMs = row.time * 1000;
        return tsMs >= startTime.getTime() - barMs && tsMs <= endTime.getTime() + barMs;
      })
      .sort((a, b) => a.time - b.time);
  };

  return {
    getPlayheadTime() {
      return now();
    },
    calculatePreviousTime(lookbackBars: number) {
      return new Date(now().getTime() - lookbackBars * barMs);
    },
    getAvailableSymbols() {
      return [...opts.symbols];
    },
    marketDataProvider: {
      async getMarketData(time: Date, symbol: string) {
        const rows = await loadRows(new Date(time.getTime() - barMs * 2), time, symbol);
        const latest = rows[rows.length - 1];
        if (!latest) {
          throw new Error(`No market data available for ${symbol}`);
        }
        return latest;
      },
      async getMarketDataRange(startTime: Date, endTime: Date, symbol: string) {
        return loadRows(startTime, endTime, symbol);
      },
    },
  };
}

function buildHistoricalSymbolCandidates(symbol: string): string[] {
  const candidates = [symbol];
  if (symbol.includes("/")) {
    const slashToDash = symbol.replace("/", "-").replace(/:.+$/, "");
    const slashRemoved = symbol.replace("/", "").replace(/:.+$/, "");
    candidates.push(slashToDash, slashRemoved);
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

function normalizeHistoricalRow(
  symbol: string,
  row: OpenBBHistoricalRow,
  barMs: number,
): LiveMarketDataBar | null {
  if (
    typeof row.date !== "string" ||
    !Number.isFinite(row.open) ||
    !Number.isFinite(row.high) ||
    !Number.isFinite(row.low) ||
    !Number.isFinite(row.close)
  ) {
    return null;
  }

  const parsed = Date.parse(row.date);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return {
    symbol,
    time: Math.floor(parsed / 1000),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume:
      typeof row.volume === "number" && Number.isFinite(row.volume)
        ? row.volume
        : 0,
    tsOpenMs: parsed,
    barIntervalMs: barMs,
    barCloseMs: parsed + barMs,
    completed: true,
    sourceDomain: "openbb",
  };
}

function intervalToMs(interval: string): number {
  const match = interval.match(/^(\d+)([mhdw])$/i);
  if (!match) {
    return 60 * 60 * 1000;
  }

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "w":
      return value * 7 * 24 * 60 * 60 * 1000;
    default:
      return 60 * 60 * 1000;
  }
}

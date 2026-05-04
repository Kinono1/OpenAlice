import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";

interface CliArgs {
  symbol: string;
  output: string;
}

interface CoinGeckoSimplePrice {
  [coinId: string]: {
    [vsCurrency: string]: number;
  };
}

interface DefiLlamaProtocol {
  id: string;
  name: string;
  tvl: number;
  chainTvls?: Record<string, number>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `alphaswarm_v2_ctx.${new Date().toISOString().replace(/[:.]/g, "")}`;
  await appendExecutionJournal({
    runId,
    batchId: "btc_paradigm_alphaswarm_v2_context",
    stage: "compiler",
    action: "input_materialization",
    status: "started",
    inputs: { symbol: args.symbol },
    outputs: { output: resolve(args.output) },
    decision: "started",
    codeRefs: ["scripts/materialize_alphaswarm_execution_context_v2.ts"],
  });

  try {
    const [btcPrice, ethPrice, dexData] = await Promise.allSettled([
      fetchCoinGeckoPrice("bitcoin"),
      fetchCoinGeckoPrice("ethereum"),
      fetchDefiLlamaDexData(),
    ]);

    const fields: Record<string, number | null> = {};

    // routingFrictionProxy: price difference between BTC and ETH normalized pairs
    if (btcPrice.status === "fulfilled" && ethPrice.status === "fulfilled") {
      const btcUsd = btcPrice.value;
      const ethUsd = ethPrice.value;
      const impliedRatio = btcUsd / ethUsd;
      // Use deviation from a "fair" ratio as friction proxy
      const frictionBps = Math.min(Math.abs(impliedRatio - 15) / 15, 1);
      fields.routingFrictionProxy = Number(clamp(frictionBps * 5, 0.05, 0.95).toFixed(4));
    } else {
      fields.routingFrictionProxy = null;
    }

    // venueDispersionProxy: DEX concentration
    if (dexData.status === "fulfilled" && dexData.value.length >= 2) {
      const tvls = dexData.value.slice(0, 10).map((p: DefiLlamaProtocol) => p.tvl);
      const total = tvls.reduce((a: number, b: number) => a + b, 0);
      const maxTvl = Math.max(...tvls);
      const hhi = tvls.reduce((a: number, b: number) => a + (b / total) ** 2, 0);
      // HHI close to 1 = concentrated = low dispersion; HHI close to 0 = dispersed
      const dispersion = 1 - hhi;
      fields.venueDispersionProxy = Number(clamp(dispersion, 0.05, 0.95).toFixed(4));
    } else {
      fields.venueDispersionProxy = null;
    }

    // liquidityStateProxy: total DEX TVL
    if (dexData.status === "fulfilled" && dexData.value.length > 0) {
      const totalTvl = dexData.value.reduce((a: number, p: DefiLlamaProtocol) => a + p.tvl, 0);
      // Normalize: $10B+ = high liquidity (0.9+), $1B- = low (0.2-)
      const logTvl = Math.log10(Math.max(totalTvl, 1));
      const liquidity = clamp((logTvl - 8) / 4, 0.05, 0.95);
      fields.liquidityStateProxy = Number(liquidity.toFixed(4));
    } else {
      fields.liquidityStateProxy = null;
    }

    const populatedCount = Object.values(fields).filter(v => v !== null).length;

    if (populatedCount < 2) {
      const unavailable = {
        schemaVersion: "alphaswarm_execution_context.v2",
        generatedAt: new Date().toISOString(),
        symbol: args.symbol,
        status: "unavailable",
        reason: "fewer_than_2_fields_populated",
        fieldStatus: {
          routingFrictionProxy: fields.routingFrictionProxy !== null ? "ok" : "failed",
          venueDispersionProxy: fields.venueDispersionProxy !== null ? "ok" : "failed",
          liquidityStateProxy: fields.liquidityStateProxy !== null ? "ok" : "failed",
        },
        provenance: {
          producer: "alphaswarm.context.external_api_proxy",
          dataSource: "external_readonly_api",
          evidenceStrength: "unavailable",
          generation: "v2_external_context",
        },
      };
      await mkdir(dirname(resolve(args.output)), { recursive: true });
      await writeFile(resolve(args.output), `${JSON.stringify(unavailable, null, 2)}\n`, "utf-8");
      await appendExecutionJournal({
        runId,
        batchId: "btc_paradigm_alphaswarm_v2_context",
        stage: "compiler",
        action: "input_materialization",
        status: "completed",
        inputs: { symbol: args.symbol },
        outputs: { output: resolve(args.output) },
        decision: "unavailable",
        codeRefs: ["scripts/materialize_alphaswarm_execution_context_v2.ts"],
        notes: [`populatedCount=${populatedCount}/3`],
      });
      console.log(`output=${resolve(args.output)} | status=unavailable | populated=${populatedCount}/3`);
      return;
    }

    const context = {
      schemaVersion: "alphaswarm_execution_context.v2",
      generatedAt: new Date().toISOString(),
      symbol: args.symbol,
      routingFrictionProxy: fields.routingFrictionProxy,
      venueDispersionProxy: fields.venueDispersionProxy,
      liquidityStateProxy: fields.liquidityStateProxy,
      provenance: {
        producer: "alphaswarm.context.external_api_proxy",
        dataSource: "external_readonly_api",
        evidenceStrength: "external",
        generation: "v2_external_context",
        apiSources: [
          "coingecko_simple_price",
          "defillama_protocols",
        ],
      },
    };

    await mkdir(dirname(resolve(args.output)), { recursive: true });
    await writeFile(resolve(args.output), `${JSON.stringify(context, null, 2)}\n`, "utf-8");
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_alphaswarm_v2_context",
      stage: "compiler",
      action: "input_materialization",
      status: "completed",
      inputs: { symbol: args.symbol },
      outputs: { output: resolve(args.output) },
      decision: "completed",
      codeRefs: ["scripts/materialize_alphaswarm_execution_context_v2.ts"],
    });
    console.log(`output=${resolve(args.output)} | populated=${populatedCount}/3`);
  } catch (error) {
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_alphaswarm_v2_context",
      stage: "compiler",
      action: "input_materialization",
      status: "failed",
      inputs: { symbol: args.symbol },
      outputs: { output: resolve(args.output) },
      decision: "failed",
      codeRefs: ["scripts/materialize_alphaswarm_execution_context_v2.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

async function fetchCoinGeckoPrice(coinId: string): Promise<number> {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const data = (await res.json()) as CoinGeckoSimplePrice;
  return data[coinId]?.usd ?? 0;
}

async function fetchDefiLlamaDexData(): Promise<DefiLlamaProtocol[]> {
  const url = "https://api.llama.fi/protocols";
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`DefiLlama ${res.status}`);
  const data = (await res.json()) as DefiLlamaProtocol[];
  // Filter to DEX-like protocols with meaningful TVL
  return data
    .filter(p => p.tvl > 1_000_000)
    .sort((a, b) => b.tvl - a.tvl)
    .slice(0, 20);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const output = raw.get("output");
  if (!output) throw new Error("--output is required.");
  return {
    symbol: raw.get("symbol") ?? "BTC/USD",
    output,
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
    out.set(key, next);
    index += 1;
  }
  return out;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

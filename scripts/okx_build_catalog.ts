import { resolve } from "path";
import {
  parseRawArgs,
  parseBoolean,
  parseIntArg,
  writeJsonFile,
  withRetry,
} from "./okx_historical_common.js";

type Instrument = {
  instId: string;
  instType: string;
  state?: string;
  quoteCcy?: string;
  settleCcy?: string;
  baseCcy?: string;
};

type ApiResponse<T> = {
  code?: string;
  msg?: string;
  data?: T[];
};

type CliArgs = {
  outputDir: string;
  quote: string;
  includeNotLive: boolean;
  maxRetries: number;
  timeoutMs: number;
};

function printHelp(): void {
  console.log(`Usage:
  pnpm tsx scripts/okx_build_catalog.ts -- [options]

Options:
  --outputDir data/market/okx_historical/catalog
  --quote USDT
  --includeNotLive true
  --maxRetries 6
  --timeoutMs 30000
`);
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  if (raw.has("help")) {
    printHelp();
    process.exit(0);
  }
  const datasetRoot = raw.get("datasetRoot");
  const outputDir =
    raw.get("outputDir") ?? (datasetRoot ? resolve(datasetRoot, "catalog") : "data/market/okx_historical/catalog");
  return {
    outputDir,
    quote: (raw.get("quote") ?? "USDT").trim().toUpperCase(),
    includeNotLive: parseBoolean(raw.get("includeNotLive"), true),
    maxRetries: parseIntArg(raw.get("maxRetries"), 6, "maxRetries"),
    timeoutMs: parseIntArg(raw.get("timeoutMs"), 30_000, "timeoutMs"),
  };
}

async function fetchInstruments(
  instType: "SPOT" | "SWAP",
  args: CliArgs
): Promise<Instrument[]> {
  const label = `instruments:${instType}`;
  return withRetry(
    async () => {
      const url = new URL("https://www.okx.com/api/v5/public/instruments");
      url.searchParams.set("instType", instType);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            "user-agent": "Mozilla/5.0",
          },
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const payload = (await res.json()) as ApiResponse<Instrument>;
        if (payload.code !== "0") {
          throw new Error(`API code=${payload.code} msg=${payload.msg ?? ""}`);
        }
        return (payload.data ?? []).filter(x => Boolean(x.instId));
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      maxRetries: args.maxRetries,
      baseDelayMs: 800,
      label,
    }
  );
}

function filterUsdt(
  rows: Instrument[],
  args: CliArgs,
  mode: "spot" | "swap"
): Instrument[] {
  return rows.filter(row => {
    const quoted = mode === "spot" ? row.quoteCcy === args.quote : row.settleCcy === args.quote;
    if (!quoted) return false;
    if (!args.includeNotLive && row.state !== "live") return false;
    return true;
  });
}

function buildIndexCandidates(spot: Instrument[], swap: Instrument[]): string[] {
  const bases = new Set<string>();
  for (const row of [...spot, ...swap]) {
    if (row.baseCcy) bases.add(row.baseCcy.toUpperCase());
  }
  return Array.from(bases)
    .map(base => `${base}-USDT`)
    .sort((a, b) => a.localeCompare(b));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [spotRaw, swapRaw] = await Promise.all([
    fetchInstruments("SPOT", args),
    fetchInstruments("SWAP", args),
  ]);

  const spot = filterUsdt(spotRaw, args, "spot");
  const swap = filterUsdt(swapRaw, args, "swap");
  const indexCandidates = buildIndexCandidates(spot, swap);

  const generatedAt = new Date().toISOString();
  const outDir = resolve(args.outputDir);
  await writeJsonFile(resolve(outDir, "usdt_spot.v1.json"), {
    schemaVersion: "okx_catalog_spot.v1",
    generatedAt,
    quote: args.quote,
    includeNotLive: args.includeNotLive,
    count: spot.length,
    items: spot,
  });
  await writeJsonFile(resolve(outDir, "usdt_swap.v1.json"), {
    schemaVersion: "okx_catalog_swap.v1",
    generatedAt,
    quote: args.quote,
    includeNotLive: args.includeNotLive,
    count: swap.length,
    items: swap,
  });
  await writeJsonFile(resolve(outDir, "usdt_all.v1.json"), {
    schemaVersion: "okx_catalog_all.v1",
    generatedAt,
    quote: args.quote,
    includeNotLive: args.includeNotLive,
    count: spot.length + swap.length,
    items: [...spot, ...swap],
  });
  await writeJsonFile(resolve(outDir, "index_candidates.v1.json"), {
    schemaVersion: "okx_index_candidates.v1",
    generatedAt,
    quote: args.quote,
    count: indexCandidates.length,
    items: indexCandidates,
  });
  await writeJsonFile(resolve(outDir, "summary.v1.json"), {
    schemaVersion: "okx_catalog_summary.v1",
    generatedAt,
    counts: {
      spotRaw: spotRaw.length,
      swapRaw: swapRaw.length,
      spotUsdt: spot.length,
      swapUsdt: swap.length,
      indexCandidates: indexCandidates.length,
    },
    outputDir: outDir,
  });

  console.log(
    `catalog built: spotUsdt=${spot.length}, swapUsdt=${swap.length}, indexCandidates=${indexCandidates.length}, outDir=${outDir}`
  );
}

main().catch(err => {
  console.error("okx_build_catalog failed:", err);
  process.exit(1);
});

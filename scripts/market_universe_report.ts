import ccxt from "ccxt";
import { mkdir, writeFile } from "fs/promises";
import { resolve } from "path";

type CliArgs = {
  quote: string;
  outPath: string;
  topN: number;
};

function parseRawArgs(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const maybeVal = argv[i + 1];
    if (!maybeVal || maybeVal.startsWith("--")) {
      map.set(key, "true");
      continue;
    }
    map.set(key, maybeVal);
    i += 1;
  }
  return map;
}

function parseIntArg(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  if (raw == null) return fallback;
  const val = Number(raw);
  if (!Number.isFinite(val) || !Number.isInteger(val) || val <= 0) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return val;
}

function parseCliArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  return {
    quote: (raw.get("quote") ?? "USDT").toUpperCase(),
    outPath: raw.get("outPath") ?? "data/market/universe/report.json",
    topN: parseIntArg(raw.get("topN"), 200, "topN"),
  };
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function readAllPrefixTags(xml: string): string[] {
  const out: string[] = [];
  const reg = /<Prefix>([^<]+)<\/Prefix>/g;
  let m: RegExpExecArray | null;
  while ((m = reg.exec(xml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function readTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m?.[1] ?? null;
}

function isTruncated(xml: string): boolean {
  return /<IsTruncated>true<\/IsTruncated>/.test(xml);
}

async function listS3Prefixes(basePrefix: string): Promise<string[]> {
  const endpoint = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
  const prefixes: string[] = [];
  let marker: string | undefined;

  while (true) {
    const url = new URL(endpoint);
    url.searchParams.set("delimiter", "/");
    url.searchParams.set("prefix", basePrefix);
    if (marker) url.searchParams.set("marker", marker);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`S3 list failed ${res.status} for ${basePrefix}`);
    }
    const xml = await res.text();
    prefixes.push(...readAllPrefixTags(xml).filter(p => p !== basePrefix));
    if (!isTruncated(xml)) break;
    const nextMarker = readTag(xml, "NextMarker");
    if (!nextMarker) break;
    marker = nextMarker;
  }
  return uniq(prefixes);
}

async function listBinanceSymbolsByMarket(
  market: "spot" | "um",
): Promise<string[]> {
  const basePrefix =
    market === "spot"
      ? "data/spot/monthly/klines/"
      : "data/futures/um/monthly/klines/";
  const matcher =
    market === "spot"
      ? /^data\/spot\/monthly\/klines\/([^/]+)\/$/
      : /^data\/futures\/um\/monthly\/klines\/([^/]+)\/$/;

  const prefixes = await listS3Prefixes(basePrefix);
  return uniq(
    prefixes
      .map(p => p.match(matcher)?.[1])
      .filter((v): v is string => Boolean(v))
      .map(v => v.toUpperCase()),
  ).sort((a, b) => a.localeCompare(b));
}

async function loadOkxSnapshot() {
  const ex = new ccxt.okx({
    enableRateLimit: true,
    timeout: 30_000,
    options: {
      fetchMarkets: { types: ["spot", "swap"] },
    },
  });
  try {
    await ex.loadMarkets(true);
    const markets = Object.values(ex.markets ?? {}) as Array<{
      symbol?: string;
      base?: string;
      quote?: string;
      settle?: string;
      type?: string;
      active?: boolean;
    }>;
    return markets;
  } finally {
    await ex.close();
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  const [okxMarkets, binanceSpot, binanceUm] = await Promise.all([
    loadOkxSnapshot(),
    listBinanceSymbolsByMarket("spot"),
    listBinanceSymbolsByMarket("um"),
  ]);

  const okxTradable = okxMarkets.filter(
    m => m.type === "spot" || m.type === "swap" || m.type === "future",
  );

  const okxQuoteFiltered = okxTradable.filter(
    m =>
      (m.quote === args.quote || m.settle === args.quote) &&
      typeof m.base === "string",
  );
  const okxSymbolsByBase = uniq(
    okxQuoteFiltered.map(m => `${String(m.base).toUpperCase()}${args.quote}`),
  ).sort((a, b) => a.localeCompare(b));

  const okxInactiveSymbols = uniq(
    okxQuoteFiltered
      .filter(m => m.active === false)
      .map(m => `${String(m.base).toUpperCase()}${args.quote}`),
  ).sort((a, b) => a.localeCompare(b));

  const binanceSpotSet = new Set(binanceSpot.filter(s => s.endsWith(args.quote)));
  const binanceUmSet = new Set(binanceUm.filter(s => s.endsWith(args.quote)));
  const binanceUnion = uniq([...binanceSpotSet, ...binanceUmSet]).sort((a, b) =>
    a.localeCompare(b),
  );

  const okxSet = new Set(okxSymbolsByBase);

  const binanceNotInOkx = binanceUnion.filter(s => !okxSet.has(s));
  const okxNotInBinance = okxSymbolsByBase.filter(
    s => !binanceSpotSet.has(s) && !binanceUmSet.has(s),
  );

  const report = {
    generatedAt: new Date().toISOString(),
    quote: args.quote,
    counts: {
      okxAllMarkets: okxMarkets.length,
      okxTradable: okxTradable.length,
      okxQuoteFilteredByBase: okxSymbolsByBase.length,
      okxInactiveQuoteFiltered: okxInactiveSymbols.length,
      binanceSpotSymbols: binanceSpot.length,
      binanceUmSymbols: binanceUm.length,
      binanceUnionQuoteFiltered: binanceUnion.length,
      binanceQuoteFilteredNotInOkx: binanceNotInOkx.length,
      okxQuoteFilteredNotInBinance: okxNotInBinance.length,
    },
    samples: {
      okxInactiveQuoteFiltered: okxInactiveSymbols.slice(0, args.topN),
      binanceQuoteFilteredNotInOkx: binanceNotInOkx.slice(0, args.topN),
      okxQuoteFilteredNotInBinance: okxNotInBinance.slice(0, args.topN),
    },
  };

  const outPath = resolve(args.outPath);
  await mkdir(resolve(outPath, ".."), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `universe report saved: ${outPath}\n` +
      `okxQuoteFilteredByBase=${report.counts.okxQuoteFilteredByBase}, ` +
      `binanceUnionQuoteFiltered=${report.counts.binanceUnionQuoteFiltered}, ` +
      `binanceNotInOkx=${report.counts.binanceQuoteFilteredNotInOkx}`,
  );
}

main().catch(err => {
  console.error("market_universe_report failed:", err);
  process.exit(1);
});

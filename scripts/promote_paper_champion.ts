import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../src/core/config.js";
import { createCryptoTradingEngine } from "../src/extension/crypto-trading/factory.js";
import { CcxtTradingEngine } from "../src/extension/crypto-trading/providers/ccxt/CcxtTradingEngine.js";
import { writePaperChampionRegistry } from "../src/runtime/paper_champion_registry.js";
import { evaluatePaperChampionPromotion } from "../src/runtime/paper_champion_promotion.js";
import { readGitState } from "../src/runtime/paper_promotion_metadata.js";
import { loadReleaseGateStatus } from "../src/runtime/release_gate_status.js";

interface CliArgs {
  validationRunsPath: string;
  verdictPath: string;
  releaseGateStatusPath: string;
  registryOutput: string;
  statusOutput: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const [validationRuns, verdict, releaseGateStatus, gitState] = await Promise.all([
    readJson(resolve(args.validationRunsPath)),
    readJson(resolve(args.verdictPath)),
    loadReleaseGateStatus(resolve(args.releaseGateStatusPath)),
    readGitState(process.cwd()),
  ]);

  const engineResult = await createCryptoTradingEngine(config);
  if (!engineResult || !(engineResult.engine instanceof CcxtTradingEngine)) {
    throw new Error("CCXT trading engine unavailable for promotion.");
  }

  try {
    const symbols =
      config.crypto.allowedSymbols.length > 0
        ? config.crypto.allowedSymbols
        : config.engine.pairs;
    const result = evaluatePaperChampionPromotion({
      validationRuns,
      validationRunsPath: resolve(args.validationRunsPath),
      verdict,
      verdictPath: resolve(args.verdictPath),
      releaseGateStatus,
      releaseGateStatusPath: resolve(args.releaseGateStatusPath),
      gitState,
      resolvedMarketIdentity: engineResult.engine.getResolvedMarketIdentities(symbols),
      symbols,
      barInterval: config.engine.timeframe,
    });

    const statusPayload: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      validationRunsPath: resolve(args.validationRunsPath),
      verdictPath: resolve(args.verdictPath),
      releaseGateStatusPath: resolve(args.releaseGateStatusPath),
      registryOutput: resolve(args.registryOutput),
      canPromote: result.canPromote,
      releaseGateProvenance: result.releaseGateProvenance,
      blockingReasons: result.blockingReasons,
      gitState,
    };

    if (result.canPromote && result.registryPayload) {
      const registry = await writePaperChampionRegistry(result.registryPayload, {
        filePath: resolve(args.registryOutput),
      });
      statusPayload.registryChecksum = registry.checksum;
    }

    await mkdir(dirname(resolve(args.statusOutput)), { recursive: true });
    await writeFile(
      resolve(args.statusOutput),
      `${JSON.stringify(statusPayload, null, 2)}\n`,
      "utf-8",
    );

    console.log(JSON.stringify(statusPayload, null, 2));
  } finally {
    await engineResult.close();
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  return {
    validationRunsPath:
      raw.get("validationRunsPath") ??
      "data/research/strategy/strategy_validation_runs.json",
    verdictPath:
      raw.get("verdictPath") ??
      "data/research/strategy/experiment_verdict.v2.json",
    releaseGateStatusPath:
      raw.get("releaseGateStatusPath") ?? "data/runtime/release_gate_status.json",
    registryOutput:
      raw.get("registryOutput") ?? "data/runtime/paper_champion_registry.json",
    statusOutput:
      raw.get("statusOutput") ??
      "data/runtime/paper_promotion_status.latest.json",
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
    out.set(key, next);
    i += 1;
  }
  return out;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf-8"));
}

main().catch((err) => {
  console.error("promote_paper_champion failed:", err);
  process.exit(1);
});

import { resolve } from "node:path";
import { RampUpStore } from "../src/deployment/ramp_up_store.js";

interface CliArgs {
  stage: string;
  effectiveDate: string;
  statePath: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = await RampUpStore.load(args.statePath);

  await store.setStageByLabel(args.stage, args.effectiveDate);
  const stage = store.getCurrentStageLabel();

  console.log(
    `ramp-up stage updated: stage=${stage}, effectiveDate=${args.effectiveDate}, state=${resolve(args.statePath)}`,
  );
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const stage = normalizeStageLabel(raw.get("stage"));
  const effectiveDate =
    raw.get("effectiveDate") ?? new Date().toISOString().slice(0, 10);
  assertDate(effectiveDate);

  return {
    stage,
    effectiveDate,
    statePath: raw.get("statePath") ?? "data/runtime/ramp_up_state.json",
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--")) {
      continue;
    }
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

function normalizeStageLabel(raw: string | undefined): string {
  if (!raw) {
    throw new Error("Missing --stage. Example: --stage 10%");
  }
  const value = raw.trim();
  if (/^\d+%$/.test(value)) {
    return value;
  }
  if (/^\d+$/.test(value)) {
    return `${value}%`;
  }
  throw new Error(`Invalid stage value: ${raw}`);
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date format: ${value}. Expected YYYY-MM-DD.`);
  }
}

main().catch((err) => {
  console.error("promote_stage failed:", err);
  process.exit(1);
});

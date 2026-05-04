import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  appendExecutionJournal,
  sanitizeError,
} from "./lib/execution_journal.js";

interface CliArgs {
  request: string;
  output: string;
  mode: "smoke" | "full";
  tradingAgentsRoot: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `tradingagents_sidecar.${new Date().toISOString().replace(/[:.]/g, "")}`;
  await appendExecutionJournal({
    runId,
    batchId: "btc_paradigm_tradingagents_sidecar",
    stage: "research_sidecar",
    action: "sidecar",
    status: "started",
    inputs: {
      request: resolve(args.request),
      mode: args.mode,
      tradingAgentsRoot: resolve(args.tradingAgentsRoot),
    },
    outputs: {
      output: resolve(args.output),
    },
    decision: "started",
    codeRefs: ["scripts/run_tradingagents_sidecar_for_btc.ts"],
  });

  try {
    await mkdir(dirname(resolve(args.output)), { recursive: true });
    await execPython(args);
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_tradingagents_sidecar",
      stage: "research_sidecar",
      action: "sidecar",
      status: "completed",
      inputs: {
        request: resolve(args.request),
        mode: args.mode,
      },
      outputs: {
        output: resolve(args.output),
      },
      decision: "completed",
      codeRefs: ["scripts/run_tradingagents_sidecar_for_btc.ts"],
    });
    console.log(`output=${resolve(args.output)} | mode=${args.mode}`);
  } catch (error) {
    const failurePath = `${args.output}.failure.txt`;
    await writeFile(resolve(failurePath), `${sanitizeError(error)}\n`, "utf-8");
    await appendExecutionJournal({
      runId,
      batchId: "btc_paradigm_tradingagents_sidecar",
      stage: "research_sidecar",
      action: "sidecar",
      status: "failed",
      inputs: {
        request: resolve(args.request),
        mode: args.mode,
      },
      outputs: {
        output: resolve(args.output),
        failure: resolve(failurePath),
      },
      decision: "failed",
      codeRefs: ["scripts/run_tradingagents_sidecar_for_btc.ts"],
      notes: [sanitizeError(error)],
    });
    throw error;
  }
}

async function execPython(args: CliArgs): Promise<void> {
  const root = resolve(args.tradingAgentsRoot);
  const existingPythonPath = process.env.PYTHONPATH;
  const pythonBin = await resolvePythonBin(root);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      pythonBin,
      [
        "scripts/run_openalice_research_sidecar.py",
        "--request",
        resolve(args.request),
        "--mode",
        args.mode,
        "--output",
        resolve(args.output),
        "--pretty",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          TRADINGAGENTS_RUNTIME_ROOT: root,
          PYTHONPATH: existingPythonPath
            ? `${root}:${existingPythonPath}`
            : root,
        },
      },
    );
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`TradingAgents sidecar exited with code ${code ?? "unknown"}`));
    });
  });
}

async function resolvePythonBin(root: string): Promise<string> {
  const venvPython = resolve(root, ".venv/bin/python3");
  try {
    await access(venvPython);
    return venvPython;
  } catch {
    return "python3";
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const request = raw.get("request");
  const output = raw.get("output");
  if (!request) throw new Error("--request is required.");
  if (!output) throw new Error("--output is required.");
  const mode = raw.get("mode") === "full" ? "full" : "smoke";
  return {
    request,
    output,
    mode,
    tradingAgentsRoot:
      raw.get("tradingagents-root") ??
      "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/TradingAgents",
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

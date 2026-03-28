import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  runCommandWithTimeout,
  type SpawnResult,
} from "../../openclaw/process/exec.js";
import {
  loadReleaseGateStatus,
  type PersistedReleaseGateStatus,
} from "../../runtime/release_gate_status.js";
import {
  validateResearchDecisionV1,
  type ResearchDecisionV1,
} from "../../runtime/research_execution_contracts.js";
import type {
  ITradingAgentsResearchRunner,
  TradingAgentsResearchRequest,
  TradingAgentsResearchResultEnvelope,
  TradingAgentsStrictResearchRequest,
} from "./types.js";
import {
  normalizeTradingAgentsResearchRequest,
  validateTradingAgentsStrictResearchRequest,
  validateTradingAgentsRequestFreshness,
} from "./types.js";
import {
  mapTradingAgentsSidecarReportToResearchDecision,
  parseTradingAgentsSidecarReport,
} from "./mapper.js";

const SAFE_SYSTEM_ENV_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PYENV_ROOT",
  "PYENV_VERSION",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "VIRTUAL_ENV",
] as const;

const REQUEST_MAX_AGE_MS = 5 * 60 * 1000;

type FailureCode =
  | "invalid_request_schema"
  | "missing_required_field"
  | "input_hash_mismatch"
  | "stale_context"
  | "sidecar_boot_failed"
  | "sidecar_timeout"
  | "sidecar_no_output_timeout"
  | "sidecar_nonzero_exit"
  | "invalid_output_schema"
  | "output_provenance_missing"
  | "unsupported_action_mapping";

interface TradingAgentsCommandResult extends Pick<
  SpawnResult,
  "code" | "signal" | "stderr" | "stdout" | "termination" | "noOutputTimedOut"
> {
  rawPayload: unknown;
  processOutputPath: string;
  rawSidecarReportPath: string;
}

interface TradingAgentsArtifactLayout {
  artifactRoot: string;
  requestPath: string;
  runDir: string;
  normalizedPath: string;
  fallbackPath: string;
  disagreementPath: string;
  scorecardsDir: string;
  stdoutPath: string;
  stderrPath: string;
  metadataPath: string;
  processOutputPath: string;
  rawSidecarReportPath: string;
}

interface TradingAgentsFailureDetails {
  failureCode: FailureCode;
  fallbackReason: string;
  timedOut: boolean;
  stderrDigest?: string;
  termination?: SpawnResult["termination"];
  processExitCode?: number | null;
  processSignal?: SpawnResult["signal"];
  stdout?: string;
  stderr?: string;
}

interface TradingAgentsRunnerDeps {
  executeCommand: (
    argv: string[],
    options: {
      timeoutMs: number;
      noOutputTimeoutMs?: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ) => Promise<SpawnResult>;
  loadGateStatus: (
    filePath: string,
  ) => Promise<PersistedReleaseGateStatus | null>;
  now: () => Date;
  uuid: () => string;
}

export interface TradingAgentsSidecarRunnerOptions {
  workingDirectory: string;
  entrypoint: string;
  artifactDir: string;
  timeoutMs: number;
  noOutputTimeoutMs?: number;
  mode: "smoke" | "full";
  pythonBin?: string;
  envAllowlist: string[];
  releaseGateStatusPath: string;
}

export interface TradingAgentsSidecarFailureArtifact {
  schemaVersion: "tradingagents_sidecar_failure.v1";
  generatedAt: string;
  sourceId: string;
  symbol: string;
  requestId: string;
  sidecarRunId: string;
  inputHash: string;
  failureCode: FailureCode;
  fallbackReason: string;
  operatorVisible: true;
  timedOut: boolean;
  stderrDigest?: string;
  termination?: SpawnResult["termination"];
  processExitCode?: number | null;
  processSignal?: SpawnResult["signal"];
  artifactPaths: {
    artifactRoot: string;
    requestPath: string;
    fallbackPath: string;
    runDir: string;
    normalizedPath: string;
    disagreementPath: string;
    scorecardsDir: string;
    stdoutPath: string;
    stderrPath: string;
    metadataPath: string;
    processOutputPath: string;
    rawSidecarReportPath: string;
  };
}

export class TradingAgentsSidecarRunError extends Error {
  constructor(
    message: string,
    public readonly artifact: TradingAgentsSidecarFailureArtifact,
  ) {
    super(message);
    this.name = "TradingAgentsSidecarRunError";
  }
}

class TradingAgentsCommandFailure extends Error {
  constructor(public readonly details: TradingAgentsFailureDetails) {
    super(`${details.failureCode}:${details.fallbackReason}`);
    this.name = "TradingAgentsCommandFailure";
  }
}

export class TradingAgentsSidecarRunner implements ITradingAgentsResearchRunner {
  private readonly deps: TradingAgentsRunnerDeps;

  constructor(
    private readonly options: TradingAgentsSidecarRunnerOptions,
    deps?: Partial<TradingAgentsRunnerDeps>,
  ) {
    this.deps = {
      executeCommand: deps?.executeCommand ?? runCommandWithTimeout,
      loadGateStatus: deps?.loadGateStatus ?? loadReleaseGateStatus,
      now: deps?.now ?? (() => new Date()),
      uuid: deps?.uuid ?? randomUUID,
    };
  }

  async run(
    request: TradingAgentsResearchRequest,
  ): Promise<ResearchDecisionV1 | TradingAgentsResearchResultEnvelope> {
    const startedAt = this.deps.now();
    const normalizedRequest = normalizeTradingAgentsResearchRequest(request, {
      requestId: this.deps.uuid(),
      sidecarRunId: this.deps.uuid(),
    });
    const runId = normalizedRequest.requestMeta.sidecarRunId;
    const artifactLayout = this.createArtifactLayout(
      resolve(this.options.artifactDir),
      runId,
    );

    await this.ensureArtifactDirectories(artifactLayout);
    await writeJson(artifactLayout.requestPath, normalizedRequest);

    try {
      this.assertStrictRequest(normalizedRequest, startedAt);
      const commandResult = await this.invokeTradingAgents(artifactLayout);
      await this.persistCommandStreams(artifactLayout, commandResult);
      await writeJson(artifactLayout.rawSidecarReportPath, commandResult.rawPayload);

      const releaseGateStatus =
        normalizedRequest.payload.decisionContext.requireReleaseGatePass
          ? await this.deps.loadGateStatus(this.options.releaseGateStatusPath)
          : await this.safeLoadGateStatus();

      const researchDecision = this.resolveResearchDecisionFromPayload({
        rawPayload: commandResult.rawPayload,
        request: normalizedRequest,
        releaseGateStatus,
      });

      await writeJson(artifactLayout.normalizedPath, researchDecision);
      await writeJson(artifactLayout.metadataPath, {
        runId,
        startedAt: startedAt.toISOString(),
        completedAt: this.deps.now().toISOString(),
        status: "completed",
        requestMeta: normalizedRequest.requestMeta,
        mode: this.options.mode,
        command: {
          pythonBin: this.options.pythonBin ?? "python3",
          entrypoint: resolve(
            this.options.workingDirectory,
            this.options.entrypoint,
          ),
        },
        releaseGateStatusPath: this.options.releaseGateStatusPath,
        termination: commandResult.termination,
        exitCode: commandResult.code,
        signal: commandResult.signal,
        artifactPaths: this.serializeArtifactPaths(artifactLayout),
      });

      return {
        researchDecision,
        rawOutput: {
          status: "completed",
          sourceId: normalizedRequest.requestMeta.sourceId,
          requestMeta: normalizedRequest.requestMeta,
          artifactPaths: this.serializeArtifactPaths(artifactLayout),
        },
      };
    } catch (error) {
      if (error instanceof TradingAgentsSidecarRunError) {
        throw error;
      }

      const failure = this.extractFailureDetails(error);
      await this.persistFailureArtifacts(
        artifactLayout,
        normalizedRequest,
        startedAt,
        failure,
      );
      const artifact: TradingAgentsSidecarFailureArtifact = {
        schemaVersion: "tradingagents_sidecar_failure.v1",
        generatedAt: this.deps.now().toISOString(),
        sourceId: normalizedRequest.requestMeta.sourceId,
        symbol: normalizedRequest.payload.symbol,
        requestId: normalizedRequest.requestMeta.requestId,
        sidecarRunId: normalizedRequest.requestMeta.sidecarRunId,
        inputHash: normalizedRequest.requestMeta.inputHash,
        failureCode: failure.failureCode,
        fallbackReason: failure.fallbackReason,
        operatorVisible: true,
        timedOut: failure.timedOut,
        stderrDigest: failure.stderrDigest,
        termination: failure.termination,
        processExitCode: failure.processExitCode,
        processSignal: failure.processSignal,
        artifactPaths: this.serializeArtifactPaths(artifactLayout),
      };
      await writeJson(artifactLayout.fallbackPath, artifact);
      throw new TradingAgentsSidecarRunError(failure.fallbackReason, artifact);
    }
  }

  private assertStrictRequest(
    request: TradingAgentsStrictResearchRequest,
    now: Date,
  ): void {
    const validationErrors = validateTradingAgentsStrictResearchRequest(request);
    if (validationErrors.length > 0) {
      const missingFieldErrors = validationErrors.filter((item) =>
        item.startsWith("missing_"),
      );
      if (missingFieldErrors.length > 0) {
        throw new Error(`missing_required_field:${missingFieldErrors.join(",")}`);
      }
      if (validationErrors.includes("input_hash_mismatch")) {
        throw new Error("input_hash_mismatch");
      }
      throw new Error(`invalid_request_schema:${validationErrors.join(",")}`);
    }

    const freshnessErrors = validateTradingAgentsRequestFreshness(
      request.requestMeta,
      now,
      REQUEST_MAX_AGE_MS,
    );
    if (freshnessErrors.includes("invalid_generated_at")) {
      throw new Error("invalid_request_schema:invalid_generated_at");
    }
    if (freshnessErrors.includes("stale_context")) {
      throw new Error("stale_context");
    }
  }

  private async invokeTradingAgents(
    artifactLayout: TradingAgentsArtifactLayout,
  ): Promise<TradingAgentsCommandResult> {
    const argv = [
      this.options.pythonBin ?? "python3",
      resolve(this.options.workingDirectory, this.options.entrypoint),
      "--request",
      artifactLayout.requestPath,
      "--mode",
      this.options.mode,
      "--output",
      artifactLayout.processOutputPath,
      "--pretty",
    ];

    let result: SpawnResult;
    try {
      result = await this.deps.executeCommand(argv, {
        timeoutMs: this.options.timeoutMs,
        noOutputTimeoutMs: this.options.noOutputTimeoutMs,
        cwd: artifactLayout.runDir,
        env: this.buildChildEnv(artifactLayout.runDir),
      });
    } catch (error) {
      throw new TradingAgentsCommandFailure({
        failureCode: "sidecar_boot_failed",
        fallbackReason:
          error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
    }

    if ((result.code ?? 1) !== 0) {
      const failureCode =
        result.termination === "no-output-timeout"
          ? ("sidecar_no_output_timeout" as const)
          : result.termination === "timeout"
            ? ("sidecar_timeout" as const)
            : ("sidecar_nonzero_exit" as const);
      throw new TradingAgentsCommandFailure({
        failureCode,
        fallbackReason:
          this.summarizeStderr(result.stderr) ??
          `Process exited with code ${result.code ?? "unknown"}.`,
        timedOut:
          failureCode === "sidecar_timeout" ||
          failureCode === "sidecar_no_output_timeout",
        stderrDigest: this.summarizeStderr(result.stderr),
        termination: result.termination,
        processExitCode: result.code,
        processSignal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }

    const rawPayload = await this.readRawPayload(
      artifactLayout.processOutputPath,
      result.stdout,
    );
    return {
      code: result.code,
      signal: result.signal,
      stderr: result.stderr,
      stdout: result.stdout,
      termination: result.termination,
      noOutputTimedOut: result.noOutputTimedOut,
      rawPayload,
      processOutputPath: artifactLayout.processOutputPath,
      rawSidecarReportPath: artifactLayout.rawSidecarReportPath,
    };
  }

  private resolveResearchDecisionFromPayload(input: {
    rawPayload: unknown;
    request: TradingAgentsStrictResearchRequest;
    releaseGateStatus: PersistedReleaseGateStatus | null;
  }): ResearchDecisionV1 {
    const directValidation = validateResearchDecisionV1(input.rawPayload);
    if (directValidation.valid && directValidation.value) {
      return directValidation.value;
    }

    const report = parseTradingAgentsSidecarReport(input.rawPayload);
    const mapped = mapTradingAgentsSidecarReportToResearchDecision({
      report,
      request: input.request,
      releaseGateStatus: input.releaseGateStatus,
      now: this.deps.now(),
    });
    const mappedValidation = validateResearchDecisionV1(mapped);
    if (!mappedValidation.valid || !mappedValidation.value) {
      throw new Error(
        `invalid_output_schema:${mappedValidation.blockingReasons.join(";")}`,
      );
    }
    return mappedValidation.value;
  }

  private buildChildEnv(runDir: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PYTHONUNBUFFERED: "1",
      TRADINGAGENTS_DISABLE_DOTENV_AUTOLOAD: "1",
      TRADINGAGENTS_RESULTS_DIR: resolve(runDir, "results"),
      TRADINGAGENTS_RUNTIME_ROOT: runDir,
      PYTHONPATH: this.buildPythonPath(),
    };

    for (const key of SAFE_SYSTEM_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }

    for (const key of this.options.envAllowlist) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }

    return env;
  }

  private buildPythonPath(): string {
    const existing = process.env.PYTHONPATH;
    return existing
      ? `${this.options.workingDirectory}:${existing}`
      : this.options.workingDirectory;
  }

  private async readRawPayload(
    processOutputPath: string,
    stdout: string,
  ): Promise<unknown> {
    try {
      const text = await readFile(processOutputPath, "utf-8");
      return JSON.parse(text);
    } catch (fileError) {
      try {
        return JSON.parse(stdout);
      } catch (stdoutError) {
        const message =
          stdoutError instanceof Error
            ? stdoutError.message
            : fileError instanceof Error
              ? fileError.message
              : "Unable to decode sidecar JSON output.";
        throw new Error(`invalid_output_schema:${message}`);
      }
    }
  }

  private async safeLoadGateStatus(): Promise<PersistedReleaseGateStatus | null> {
    try {
      return await this.deps.loadGateStatus(this.options.releaseGateStatusPath);
    } catch {
      return null;
    }
  }

  private classifyFailureCode(error: unknown): FailureCode {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("missing_required_field")) {
      return "missing_required_field";
    }
    if (message.startsWith("input_hash_mismatch")) {
      return "input_hash_mismatch";
    }
    if (message.startsWith("stale_context")) {
      return "stale_context";
    }
    if (message.startsWith("sidecar_boot_failed")) {
      return "sidecar_boot_failed";
    }
    if (message.startsWith("sidecar_timeout")) {
      return "sidecar_timeout";
    }
    if (message.startsWith("sidecar_no_output_timeout")) {
      return "sidecar_no_output_timeout";
    }
    if (message.startsWith("sidecar_nonzero_exit")) {
      return "sidecar_nonzero_exit";
    }
    if (message.startsWith("output_provenance_missing")) {
      return "output_provenance_missing";
    }
    if (message.startsWith("unsupported_action_mapping")) {
      return "unsupported_action_mapping";
    }
    if (message.startsWith("invalid_output_schema")) {
      return "invalid_output_schema";
    }
    return "invalid_request_schema";
  }

  private createArtifactLayout(
    artifactRoot: string,
    runId: string,
  ): TradingAgentsArtifactLayout {
    const runDir = resolve(artifactRoot, "sidecar-runs", runId);
    return {
      artifactRoot,
      requestPath: resolve(artifactRoot, "requests", `${runId}.request.json`),
      runDir,
      normalizedPath: resolve(
        artifactRoot,
        "normalized",
        `${runId}.research_decision.json`,
      ),
      fallbackPath: resolve(artifactRoot, "fallbacks", `${runId}.fallback.json`),
      disagreementPath: resolve(
        artifactRoot,
        "disagreements",
        `${runId}.research_disagreement.json`,
      ),
      scorecardsDir: resolve(artifactRoot, "scorecards"),
      stdoutPath: resolve(runDir, "stdout.log"),
      stderrPath: resolve(runDir, "stderr.log"),
      metadataPath: resolve(runDir, "run_metadata.json"),
      processOutputPath: resolve(runDir, "process_output.json"),
      rawSidecarReportPath: resolve(
        runDir,
        "process_output.raw_sidecar_report.json",
      ),
    };
  }

  private async ensureArtifactDirectories(
    artifactLayout: TradingAgentsArtifactLayout,
  ): Promise<void> {
    await mkdir(dirname(artifactLayout.requestPath), { recursive: true });
    await mkdir(dirname(artifactLayout.normalizedPath), { recursive: true });
    await mkdir(dirname(artifactLayout.fallbackPath), { recursive: true });
    await mkdir(dirname(artifactLayout.disagreementPath), { recursive: true });
    await mkdir(artifactLayout.scorecardsDir, { recursive: true });
    await mkdir(artifactLayout.runDir, { recursive: true });
  }

  private serializeArtifactPaths(artifactLayout: TradingAgentsArtifactLayout) {
    return {
      artifactRoot: artifactLayout.artifactRoot,
      requestPath: artifactLayout.requestPath,
      runDir: artifactLayout.runDir,
      normalizedPath: artifactLayout.normalizedPath,
      fallbackPath: artifactLayout.fallbackPath,
      disagreementPath: artifactLayout.disagreementPath,
      scorecardsDir: artifactLayout.scorecardsDir,
      stdoutPath: artifactLayout.stdoutPath,
      stderrPath: artifactLayout.stderrPath,
      metadataPath: artifactLayout.metadataPath,
      processOutputPath: artifactLayout.processOutputPath,
      rawSidecarReportPath: artifactLayout.rawSidecarReportPath,
    };
  }

  private async persistCommandStreams(
    artifactLayout: TradingAgentsArtifactLayout,
    commandResult: Pick<TradingAgentsCommandResult, "stdout" | "stderr">,
  ): Promise<void> {
    await writeFile(artifactLayout.stdoutPath, commandResult.stdout, "utf-8");
    await writeFile(artifactLayout.stderrPath, commandResult.stderr, "utf-8");
  }

  private extractFailureDetails(error: unknown): TradingAgentsFailureDetails {
    if (error instanceof TradingAgentsCommandFailure) {
      return error.details;
    }
    return {
      failureCode: this.classifyFailureCode(error),
      fallbackReason: error instanceof Error ? error.message : String(error),
      timedOut: false,
    };
  }

  private async persistFailureArtifacts(
    artifactLayout: TradingAgentsArtifactLayout,
    request: TradingAgentsStrictResearchRequest,
    startedAt: Date,
    failure: TradingAgentsFailureDetails,
  ): Promise<void> {
    if (failure.stdout !== undefined || failure.stderr !== undefined) {
      await this.persistCommandStreams(artifactLayout, {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      });
    }

    await writeJson(artifactLayout.metadataPath, {
      runId: request.requestMeta.sidecarRunId,
      startedAt: startedAt.toISOString(),
      completedAt: this.deps.now().toISOString(),
      status: "failed",
      requestMeta: request.requestMeta,
      mode: this.options.mode,
      command: {
        pythonBin: this.options.pythonBin ?? "python3",
        entrypoint: resolve(
          this.options.workingDirectory,
          this.options.entrypoint,
        ),
      },
      releaseGateStatusPath: this.options.releaseGateStatusPath,
      failure: {
        failureCode: failure.failureCode,
        fallbackReason: failure.fallbackReason,
        timedOut: failure.timedOut,
        stderrDigest: failure.stderrDigest,
        termination: failure.termination,
        processExitCode: failure.processExitCode,
        processSignal: failure.processSignal,
      },
      artifactPaths: this.serializeArtifactPaths(artifactLayout),
    });
  }

  private summarizeStderr(stderr: string | null | undefined): string | undefined {
    if (typeof stderr !== "string") {
      return undefined;
    }
    const compact = stderr.trim();
    if (!compact) {
      return undefined;
    }
    return compact.length > 4000 ? `${compact.slice(0, 4000)}...` : compact;
  }
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

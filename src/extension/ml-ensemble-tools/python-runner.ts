import { access, mkdtemp, rm, writeFile } from "fs/promises";
import { constants } from "fs";
import { tmpdir } from "os";
import { basename, isAbsolute, join, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type {
  MlEnsemblePredictInput,
  MlEnsemblePredictResult,
} from "./types.js";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = resolve("scripts/ml_ensemble_v1.py");
const LOCAL_VENV_PYTHON = resolve(".venv/bin/python");
export const MAX_ML_ENSEMBLE_INPUT_BYTES = 2 * 1024 * 1024;
const PYTHON_EXECUTABLE_BASENAME_RE = /^python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/i;

async function fileExists(path: string, mode = constants.F_OK) {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

async function supportsTorch(python: string) {
  try {
    await execFileAsync(python, ["-c", "import torch"], {
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function inputNeedsTorch(input: MlEnsemblePredictInput) {
  const include = input.includeModels;
  if (!include || include.length === 0) {
    // Python backend defaults include pytorch now.
    return true;
  }
  return include.includes("pytorch");
}

export function validateMlEnsemblePythonOverride(rawPath: string | undefined): string | null {
  const custom = rawPath?.trim();
  if (!custom) {
    return null;
  }
  if (/[\0\r\n]/.test(custom)) {
    throw new Error("ML_ENSEMBLE_PYTHON cannot contain control-line characters.");
  }
  if (!isAbsolute(custom)) {
    throw new Error("ML_ENSEMBLE_PYTHON must be an absolute path to a Python executable.");
  }
  const executableName = basename(custom);
  if (!PYTHON_EXECUTABLE_BASENAME_RE.test(executableName)) {
    throw new Error(
      `ML_ENSEMBLE_PYTHON must point to a Python executable named python/python3, got "${executableName}".`
    );
  }
  return custom;
}

export function serializeMlEnsembleInput(input: MlEnsemblePredictInput): string {
  const json = JSON.stringify(input);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > MAX_ML_ENSEMBLE_INPUT_BYTES) {
    throw new Error(
      `ML ensemble input is too large (${byteLength} bytes; max ${MAX_ML_ENSEMBLE_INPUT_BYTES}).`
    );
  }
  return json;
}

async function resolvePythonExecutable(input: MlEnsemblePredictInput) {
  const needsTorch = inputNeedsTorch(input);
  const custom = validateMlEnsemblePythonOverride(process.env.ML_ENSEMBLE_PYTHON);
  if (custom && (await fileExists(custom, constants.X_OK))) {
    if (!needsTorch || (await supportsTorch(custom))) {
      return custom;
    }
  }

  const candidates: string[] = [];
  if (await fileExists(LOCAL_VENV_PYTHON, constants.X_OK)) {
    candidates.push(LOCAL_VENV_PYTHON);
  }
  candidates.push("python", "python3");

  if (!needsTorch) {
    return candidates[0]!;
  }

  for (const candidate of candidates) {
    if (await supportsTorch(candidate)) {
      return candidate;
    }
  }

  // Fall back to first available executable. Backend will gracefully drop pytorch model.
  return candidates[0]!;
}

export async function runMlEnsemblePredict(
  input: MlEnsemblePredictInput
): Promise<MlEnsemblePredictResult> {
  if (!(await fileExists(SCRIPT_PATH))) {
    throw new Error(`ML ensemble script not found: ${SCRIPT_PATH}`);
  }

  const python = await resolvePythonExecutable(input);
  const workdir = await mkdtemp(join(tmpdir(), "openalice-ml-"));
  const inputPath = join(workdir, "input.json");
  try {
    await writeFile(inputPath, serializeMlEnsembleInput(input), "utf-8");
    const { stdout, stderr } = await execFileAsync(
      python,
      [SCRIPT_PATH, "--input", inputPath],
      {
        maxBuffer: 16 * 1024 * 1024,
      }
    );

    const out = stdout.trim();
    if (!out) {
      throw new Error(
        `ML ensemble script returned empty stdout. stderr: ${stderr.trim()}`
      );
    }
    return JSON.parse(out) as MlEnsemblePredictResult;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      [
        "Failed to run ML ensemble Python backend.",
        `python: ${python}`,
        `script: ${SCRIPT_PATH}`,
        `reason: ${reason}`,
        "Hint: set ML_ENSEMBLE_PYTHON to your conda python or install deps in .venv (`pip install -r scripts/requirements-ml-ensemble.txt`).",
      ].join(" ")
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

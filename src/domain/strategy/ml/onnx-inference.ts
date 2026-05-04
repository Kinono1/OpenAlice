import { stat } from 'node:fs/promises'

import type {
  StrategyForecastPrediction,
  StrategyOnnxInferenceInput,
  StrategyOnnxInferenceResult,
} from './types.js'

type OrtModule = {
  Tensor: new (
    type: string,
    data: Float32Array,
    dims: number[],
  ) => unknown
  InferenceSession: {
    create: (modelPath: string) => Promise<OrtSession>
  }
}

type OrtSession = {
  inputNames: string[]
  outputNames: string[]
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: ArrayLike<number> }>>
}

interface CachedOrtSession {
  cacheKey: string
  session: OrtSession
}

const dynamicImport = new Function(
  'moduleName',
  'return import(moduleName)',
) as (moduleName: string) => Promise<OrtModule>

const MAX_CACHED_ONNX_SESSIONS = 4
const sessionCache = new Map<string, CachedOrtSession>()

export class OnnxRuntimeUnavailableError extends Error {
  constructor() {
    super(
      'onnxruntime-node is not installed. Add it to dependencies before running ONNX inference.',
    )
    this.name = 'OnnxRuntimeUnavailableError'
  }
}

export class StrategyOnnxInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StrategyOnnxInputError'
  }
}

export class StrategyOnnxModelNotFoundError extends Error {
  constructor(modelPath: string) {
    super(`ONNX model file was not found: ${modelPath}`)
    this.name = 'StrategyOnnxModelNotFoundError'
  }
}

export class StrategyOnnxOutputMissingError extends Error {
  constructor(outputName: string) {
    super(`ONNX output ${outputName} was not returned by the session.`)
    this.name = 'StrategyOnnxOutputMissingError'
  }
}

function validateInferenceWindow(window: number[][], expectedFeatureCount?: number): void {
  if (window.length === 0) {
    throw new StrategyOnnxInputError('Inference window must contain at least one row.')
  }

  const columnCount = window[0]?.length ?? 0
  if (columnCount === 0) {
    throw new StrategyOnnxInputError('Inference window rows must contain at least one feature.')
  }

  window.forEach((row, index) => {
    if (row.length !== columnCount) {
      throw new StrategyOnnxInputError(
        `Inference window must be rectangular; row 0 has width ${columnCount}, row ${index} has width ${row.length}.`,
      )
    }
  })

  if (
    typeof expectedFeatureCount === 'number'
    && Number.isFinite(expectedFeatureCount)
    && expectedFeatureCount > 0
    && columnCount !== expectedFeatureCount
  ) {
    throw new StrategyOnnxInputError(
      `Inference window width ${columnCount} does not match expected feature count ${expectedFeatureCount}.`,
    )
  }
}

async function loadOrtModule(): Promise<OrtModule> {
  try {
    return await dynamicImport('onnxruntime-node')
  } catch {
    throw new OnnxRuntimeUnavailableError()
  }
}

export function clearStrategyOnnxSessionCache(): void {
  sessionCache.clear()
}

export function getStrategyOnnxSessionCacheStats(): { size: number; maxSize: number } {
  return {
    size: sessionCache.size,
    maxSize: MAX_CACHED_ONNX_SESSIONS,
  }
}

async function resolveSession(
  modelPath: string,
): Promise<{ ort: OrtModule; session: OrtSession }> {
  let modelStat: Awaited<ReturnType<typeof stat>>
  try {
    modelStat = await stat(modelPath)
  } catch {
    throw new StrategyOnnxModelNotFoundError(modelPath)
  }

  const cacheKey = `${modelPath}:${modelStat.mtimeMs}:${modelStat.size}`
  const cached = sessionCache.get(modelPath)
  if (cached?.cacheKey === cacheKey) {
    const ort = await loadOrtModule()
    sessionCache.delete(modelPath)
    sessionCache.set(modelPath, cached)
    return { ort, session: cached.session }
  }

  const ort = await loadOrtModule()
  const session = await ort.InferenceSession.create(modelPath)
  sessionCache.set(modelPath, { cacheKey, session })
  while (sessionCache.size > MAX_CACHED_ONNX_SESSIONS) {
    const oldestKey = sessionCache.keys().next().value
    if (typeof oldestKey !== 'string') {
      break
    }
    sessionCache.delete(oldestKey)
  }
  return { ort, session }
}

export async function runStrategyOnnxInference(
  input: StrategyOnnxInferenceInput,
): Promise<StrategyOnnxInferenceResult> {
  validateInferenceWindow(input.window, input.expectedFeatureCount)
  const { ort, session } = await resolveSession(input.modelPath)
  const inputName = session.inputNames[0]
  const outputName = input.outputName ?? session.outputNames[0]
  const rows = input.window.length
  const columns = input.window[0]?.length ?? 0
  const flattened = new Float32Array(rows * columns)

  input.window.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      flattened[rowIndex * columns + columnIndex] = value
    })
  })

  const tensor = new ort.Tensor('float32', flattened, [1, rows, columns])
  const outputs = await session.run({ [inputName]: tensor })
  const output = outputs[outputName]
  if (!output) {
    throw new StrategyOnnxOutputMissingError(outputName)
  }

  return {
    outputName,
    values: Array.from(output.data),
  }
}

export async function inferStrategyForecast(
  input: StrategyOnnxInferenceInput & {
    horizonHours: number
    threshold?: number
  },
): Promise<StrategyForecastPrediction> {
  const result = await runStrategyOnnxInference(input)
  const score = result.values[0] ?? 0
  const threshold = input.threshold ?? 0.05
  return {
    horizonHours: input.horizonHours,
    score,
    confidence: Math.min(1, Math.abs(score)),
    direction:
      score > threshold ? 'up' : score < -threshold ? 'down' : 'flat',
    modelPath: input.modelPath,
    architecture: input.architecture,
    metadata: {
      outputName: result.outputName,
      outputWidth: result.values.length,
    },
  }
}

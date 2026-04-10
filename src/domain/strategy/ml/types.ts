export type StrategyForecastArchitecture = 'lstm' | 'patchtst'

export interface StrategyMlFeatureVector {
  names: string[]
  values: number[]
  record: Record<string, number>
}

export interface FeatureNormalizationStats {
  featureNames: string[]
  mean: number[]
  std: number[]
}

export interface StrategyMlModelConfig {
  enabled: boolean
  architecture: StrategyForecastArchitecture
  modelPath?: string
  lookbackSteps: number
  forecastHorizonHours: number
  decisionThreshold: number
}

export interface StrategyForecastPrediction {
  horizonHours: number
  score: number
  confidence: number
  direction: 'up' | 'down' | 'flat'
  modelPath: string
  architecture?: StrategyForecastArchitecture
  metadata?: Record<string, number | string | boolean | null>
}

export interface StrategyOnnxInferenceInput {
  modelPath: string
  window: number[][]
  outputName?: string
  architecture?: StrategyForecastArchitecture
  expectedFeatureCount?: number
}

export interface StrategyOnnxInferenceResult {
  outputName: string
  values: number[]
}

export interface StrategyMlArtifactMetadata {
  architecture: StrategyForecastArchitecture
  featureNames: string[]
  inputDim: number
  lookback: number
  horizon: number
  checkpointPath?: string
  normalizationPath?: string
  onnxPath?: string
}

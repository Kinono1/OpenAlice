export {
  computeSpaLikePValues,
  computeDeflatedSharpe,
  estimatePboCscv,
  evaluateSignificanceGate,
} from './statistical_significance.js'

export type {
  PboInput,
  PboResult,
  DeflatedSharpeInput,
  DeflatedSharpeResult,
  SpaLikeInput,
  SpaLikeCandidateResult,
  SpaLikeResult,
  SignificanceGateInput,
  SignificanceGateResult,
} from './statistical_significance.js'

export { evaluateReleaseGate } from './release_gate.js'

export type {
  ReleaseGateStatus,
  ReleaseGateCheck,
  ReleaseGateThresholds,
  ReleaseGateInput,
  ReleaseGateResult,
  SlippageGateDecision,
  RampUpEvaluation,
  RegimeShiftGateInput,
} from './release_gate.js'

export { evaluateRiskSimulation } from './risk_simulation.js'

export type {
  RiskSimulationMethod,
  RiskSimulationConfig,
  RiskSimulationPathStats,
  RiskSimulationResult,
} from './risk_simulation.js'

export {
  benjaminiHochberg,
  benjaminiYekutieli,
  runFdrCorrection,
} from './fdr.js'

export type {
  FdrMethod,
  FdrItem,
  FdrDiagnostics,
  RunFdrCorrectionInput,
  RunFdrCorrectionResult,
} from './fdr.js'

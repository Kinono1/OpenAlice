export { createTradingAgentsResearchTools, buildTradingAgentsResearchRequest } from "./adapter.js";
export {
  mapTradingAgentsSidecarReportToResearchDecision,
  parseTradingAgentsSidecarReport,
  toTradingAgentsTicker,
} from "./mapper.js";
export {
  buildResearchDecisionOperatorSummary,
  buildTradingAgentsFallbackSummary,
  createResearchDecisionDisagreementArtifact,
} from "./disagreement.js";
export { TradingAgentsSidecarRunner } from "./runner.js";
export type {
  ITradingAgentsResearchRunner,
  TradingAgentsAnalyst,
  TradingAgentsResearchInput,
  TradingAgentsResearchRequest,
  TradingAgentsResearchResultEnvelope,
  TradingAgentsResearchToolResult,
} from "./types.js";
export type { TradingAgentsSidecarReportV1 } from "./mapper.js";
export type { TradingAgentsSidecarRunnerOptions } from "./runner.js";
export type {
  ResearchDecisionDisagreementArtifact,
  ResearchDecisionOperatorSummary,
  TradingAgentsFallbackSummary,
  TradingAgentsFallbackSummaryInput,
} from "./disagreement.js";

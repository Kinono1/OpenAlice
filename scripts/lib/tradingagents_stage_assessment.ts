export type TradingAgentsStage = "A" | "B" | "C" | "D";
export type TradingAgentsStageStatus = "pass" | "fail" | "inconclusive";

export interface TradingAgentsStageCriterion {
  id: string;
  description: string;
  status: TradingAgentsStageStatus;
  evidence: string;
}

export interface TradingAgentsStageAssessment {
  stage: TradingAgentsStage;
  label: string;
  status: TradingAgentsStageStatus;
  criteria: TradingAgentsStageCriterion[];
}

export interface TradingAgentsStageSnapshot {
  currentStage: TradingAgentsStage;
  currentStageStatus: TradingAgentsStageStatus;
  stages: TradingAgentsStageAssessment[];
  recommendation: string;
}

interface DerivedValidationQuestions {
  donorLeadsNonControls: boolean | null;
  controlsAreStrongerThanDonor: boolean | null;
  donorSelfPassesThresholds: boolean | null;
}

interface DerivedDonorAggregateMetrics {
  meanPbo: number;
  meanDsrProbability: number;
  fdrQ: number;
  maxFailedWindowRatio: number | null;
}

export function buildTradingAgentsStageSnapshot(params: {
  validationRuns: Record<string, unknown> | null;
  routeMatrix: Record<string, unknown> | null;
  wfoSensitivity: Record<string, unknown> | null;
}): TradingAgentsStageSnapshot {
  const stages = [
    assessStageA(params.validationRuns),
    assessStageB(params.validationRuns, params.routeMatrix),
    assessStageC(params.validationRuns, params.routeMatrix, params.wfoSensitivity),
    assessStageD(params.validationRuns, params.routeMatrix),
  ];
  const currentStage = determineCurrentStage(stages);
  const currentStageStatus =
    stages.find((stage) => stage.stage === currentStage)?.status ?? "inconclusive";
  return {
    currentStage,
    currentStageStatus,
    stages,
    recommendation: buildRecommendation(currentStage, currentStageStatus, stages),
  };
}

export function deriveValidationQuestions(
  validationRuns: Record<string, unknown>,
): DerivedValidationQuestions {
  const diagnostics = validationRuns.diagnostics as Record<string, unknown> | undefined;
  const questions = diagnostics?.questions as Record<string, unknown> | undefined;
  const directDonorLeads =
    typeof questions?.donorLeadsNonControls === "boolean"
      ? (questions.donorLeadsNonControls as boolean)
      : null;
  const directControlsStronger =
    typeof questions?.controlsAreStrongerThanDonor === "boolean"
      ? (questions.controlsAreStrongerThanDonor as boolean)
      : null;
  const directDonorSelfPasses =
    typeof questions?.donorSelfPassesThresholds === "boolean"
      ? (questions.donorSelfPassesThresholds as boolean)
      : null;

  const donorMetrics = deriveDonorAggregateMetrics(validationRuns);
  const symbols = Array.isArray(validationRuns.symbols) ? validationRuns.symbols : [];
  const hasLeader = symbols.some(
    (symbol: unknown) => isPlainObject(symbol) && symbol.leader !== null && symbol.leader !== undefined,
  );
  const leaderDonor = symbols.every((symbol: unknown) => {
    if (!isPlainObject(symbol)) {
      return true;
    }
    return symbol.leader ? isDonorRecord(symbol.leader) : false;
  });

  return {
    donorLeadsNonControls: directDonorLeads ?? (hasLeader ? leaderDonor : null),
    controlsAreStrongerThanDonor:
      directControlsStronger ?? (hasLeader ? !leaderDonor : null),
    donorSelfPassesThresholds:
      directDonorSelfPasses ??
      (donorMetrics
        ? donorMetrics.meanPbo <= 0.2 &&
          donorMetrics.meanDsrProbability >= 0.5 &&
          donorMetrics.fdrQ <= 0.1
        : null),
  };
}

export function deriveDonorAggregateMetrics(
  validationRuns: Record<string, unknown>,
): DerivedDonorAggregateMetrics | null {
  const diagnostics = validationRuns.diagnostics as Record<string, unknown> | undefined;
  const donorOnly = diagnostics?.donorOnlyAggregateMetrics as Record<string, unknown> | undefined;
  if (donorOnly) {
    const meanPbo = toFiniteNumber(donorOnly.meanPbo);
    const meanDsrProbability = toFiniteNumber(donorOnly.meanDsrProbability);
    const fdrQ = toFiniteNumber(donorOnly.fdrQ);
    const maxFailedWindowRatio = toFiniteNumber(donorOnly.maxFailedWindowRatio);
    if (meanPbo !== null && meanDsrProbability !== null && fdrQ !== null) {
      return { meanPbo, meanDsrProbability, fdrQ, maxFailedWindowRatio };
    }
  }

  const donors = extractDonorCandidates(validationRuns);
  if (donors.length < 1) {
    return null;
  }

  const pboValues = donors
    .map((candidate) => {
      const significance = (candidate.candidateLevelSignificance ?? candidate.significance) as
        | Record<string, unknown>
        | undefined;
      return toFiniteNumber(significance?.pbo);
    })
    .filter((value): value is number => value !== null);
  const dsrValues = donors
    .map((candidate) => {
      const significance = (candidate.candidateLevelSignificance ?? candidate.significance) as
        | Record<string, unknown>
        | undefined;
      return toFiniteNumber(significance?.dsrProbability);
    })
    .filter((value): value is number => value !== null);
  const fdrValues = donors
    .map((candidate) => {
      const fdr = (candidate.candidateLevelFdr ?? candidate.fdr) as
        | Record<string, unknown>
        | undefined;
      return toFiniteNumber(fdr?.qValue);
    })
    .filter((value): value is number => value !== null);
  const failedWindowRatios = donors
    .map((candidate) => {
      const releaseGate = candidate.releaseGate as Record<string, unknown> | undefined;
      const checks = Array.isArray(releaseGate?.checks) ? releaseGate.checks : [];
      const wfoCheck = checks.find(
        (check) => isPlainObject(check) && check.name === "wfo",
      ) as Record<string, unknown> | undefined;
      const metrics = wfoCheck?.metrics as Record<string, unknown> | undefined;
      return toFiniteNumber(metrics?.failedWindowRatio);
    })
    .filter((value): value is number => value !== null);

  if (pboValues.length < 1 || dsrValues.length < 1 || fdrValues.length < 1) {
    return null;
  }

  return {
    meanPbo: average(pboValues),
    meanDsrProbability: average(dsrValues),
    fdrQ: average(fdrValues),
    maxFailedWindowRatio:
      failedWindowRatios.length > 0 ? Math.max(...failedWindowRatios) : null,
  };
}

function assessStageA(
  validationRuns: Record<string, unknown> | null,
): TradingAgentsStageAssessment {
  const criteria: TradingAgentsStageCriterion[] = [];

  if (!validationRuns) {
    return {
      stage: "A",
      label: "Relative Merit",
      status: "inconclusive",
      criteria: [
        {
          id: "data_available",
          description: "Validation runs data available",
          status: "inconclusive",
          evidence: "No validation runs data provided.",
        },
      ],
    };
  }

  const questions = deriveValidationQuestions(validationRuns);
  const donorLeadsNonControls = questions.donorLeadsNonControls;
  criteria.push({
    id: "A1_donor_beats_baseline",
    description: "Donor beats BASELINE_CONTROL in SPA comparison",
    status:
      donorLeadsNonControls === null
        ? "inconclusive"
        : donorLeadsNonControls
          ? "pass"
          : "fail",
    evidence:
      donorLeadsNonControls === null
        ? "Donor-vs-non-control leadership is unavailable in this artifact."
        : donorLeadsNonControls
          ? "Donor is the strongest non-control candidate across all symbols."
          : "Donor does not consistently lead non-control candidates.",
  });

  const donorCandidates = extractDonorCandidates(validationRuns);
  const donorFdrQ = donorCandidates
    .map((candidate: unknown) => {
      const fdr = (candidate as Record<string, unknown>)?.fdr as
        | Record<string, unknown>
        | undefined;
      return toFiniteNumber(fdr?.qValue);
    })
    .filter((value): value is number => value !== null);
  const donorPassesFdr =
    donorFdrQ.length > 0 && donorFdrQ.every((qValue) => qValue <= 0.1);
  criteria.push({
    id: "A2_donor_spa_fdr_passes",
    description: "Donor SPA q-value < 0.10",
    status: donorPassesFdr ? "pass" : donorFdrQ.length > 0 ? "fail" : "inconclusive",
    evidence:
      donorFdrQ.length > 0
        ? `Donor FDR q-values: [${donorFdrQ
            .map((qValue) => qValue.toFixed(4))
            .join(", ")}]`
        : "No donor candidates found in validation runs.",
  });

  const donorSharpes = donorCandidates
    .map((candidate: unknown) => {
      const backtestMetrics = (candidate as Record<string, unknown>)?.backtestMetrics as
        | Record<string, unknown>
        | undefined;
      return toFiniteNumber(backtestMetrics?.sharpe);
    })
    .filter((value): value is number => value !== null);
  const donorPositiveSharpe =
    donorSharpes.length > 0 && donorSharpes.every((sharpe) => sharpe > 0);
  criteria.push({
    id: "A3_donor_positive_sharpe",
    description: "Donor has positive Sharpe ratio",
    status:
      donorSharpes.length > 0
        ? donorPositiveSharpe
          ? "pass"
          : "fail"
        : "inconclusive",
    evidence:
      donorSharpes.length > 0
        ? `Donor Sharpe: [${donorSharpes
            .map((sharpe) => sharpe.toFixed(3))
            .join(", ")}]`
        : "No donor candidates found.",
  });

  const donorSelfPasses = questions.donorSelfPassesThresholds;
  criteria.push({
    id: "A4_donor_self_passes_thresholds",
    description: "Donor individual PBO/DSR/FDR pass thresholds (diagnostic view)",
    status:
      donorSelfPasses === null ? "inconclusive" : donorSelfPasses ? "pass" : "inconclusive",
    evidence:
      donorSelfPasses === null
        ? "Donor-only aggregate metrics are unavailable in this artifact."
        : donorSelfPasses
          ? "Donor-only aggregate metrics pass all thresholds."
          : "Donor-only metrics do not all pass (see diagnostics for details).",
  });

  return {
    stage: "A",
    label: "Relative Merit",
    status: deriveStageStatus(criteria, [
      "A1_donor_beats_baseline",
      "A2_donor_spa_fdr_passes",
      "A3_donor_positive_sharpe",
    ]),
    criteria,
  };
}

function assessStageB(
  validationRuns: Record<string, unknown> | null,
  routeMatrix: Record<string, unknown> | null,
): TradingAgentsStageAssessment {
  const criteria: TradingAgentsStageCriterion[] = [];

  if (!validationRuns) {
    return {
      stage: "B",
      label: "Robust Superiority",
      status: "inconclusive",
      criteria: [
        {
          id: "data_available",
          description: "Validation runs data available",
          status: "inconclusive",
          evidence: "No data.",
        },
      ],
    };
  }

  const symbols = Array.isArray(validationRuns.symbols) ? validationRuns.symbols : [];
  const donorIsChampion = symbols.every((symbol: unknown) => {
    if (!isPlainObject(symbol)) {
      return true;
    }
    const champion = isPlainObject(symbol.champion)
      ? (symbol.champion as Record<string, unknown>)
      : null;
    return champion === null || isDonorRecord(champion);
  });
  const hasChampion = symbols.some((symbol: unknown) => {
    if (!isPlainObject(symbol)) {
      return false;
    }
    return symbol.champion !== null;
  });
  criteria.push({
    id: "B1_donor_is_champion",
    description: "Donor is champion in validation pool",
    status: hasChampion && donorIsChampion ? "pass" : "fail",
    evidence: hasChampion
      ? donorIsChampion
        ? "Donor is champion across all symbols."
        : "Donor is not champion — a control or anchor outperforms it."
      : "No champion selected (likely all candidates failed).",
  });

  const questions = deriveValidationQuestions(validationRuns);
  const controlsNotStronger = questions.controlsAreStrongerThanDonor;
  criteria.push({
    id: "B2_controls_not_stronger",
    description: "No control outperforms donor",
    status:
      controlsNotStronger === null
        ? "inconclusive"
        : controlsNotStronger
          ? "pass"
          : "fail",
    evidence:
      controlsNotStronger === null
        ? "Donor-vs-control ordering is unavailable in this artifact."
        : controlsNotStronger
          ? "Donor outperforms all controls."
          : "At least one control or anchor outperforms the donor.",
  });

  if (routeMatrix) {
    const recommendedProfile =
      typeof routeMatrix.recommendedProfile === "string"
        ? routeMatrix.recommendedProfile
        : null;
    const profiles = Array.isArray(routeMatrix.profiles) ? routeMatrix.profiles : [];
    const hasGoProfile = profiles.some(
      (profile: unknown) =>
        isPlainObject(profile) && (profile as Record<string, unknown>).result === "GO",
    );
    criteria.push({
      id: "B3_route_matrix_has_go",
      description: "At least one route matrix profile achieves GO",
      status: hasGoProfile ? "pass" : "fail",
      evidence: hasGoProfile
        ? `GO profile found. Recommended: ${recommendedProfile ?? "none"}`
        : `No GO profiles. Recommended: ${recommendedProfile ?? "none"}. All profiles NO_GO.`,
    });
  } else {
    criteria.push({
      id: "B3_route_matrix_has_go",
      description: "Route matrix data available for robust check",
      status: "inconclusive",
      evidence: "No route matrix data provided.",
    });
  }

  return {
    stage: "B",
    label: "Robust Superiority",
    status: deriveStageStatus(criteria, [
      "B1_donor_is_champion",
      "B2_controls_not_stronger",
      "B3_route_matrix_has_go",
    ]),
    criteria,
  };
}

function assessStageC(
  validationRuns: Record<string, unknown> | null,
  _routeMatrix: Record<string, unknown> | null,
  wfoSensitivity: Record<string, unknown> | null,
): TradingAgentsStageAssessment {
  const criteria: TradingAgentsStageCriterion[] = [];

  if (!validationRuns) {
    return {
      stage: "C",
      label: "Robust Admission Feasibility",
      status: "inconclusive",
      criteria: [
        {
          id: "data",
          description: "Data available",
          status: "inconclusive",
          evidence: "No data.",
        },
      ],
    };
  }

  const aggregateMetrics = validationRuns.aggregateMetrics as
    | Record<string, unknown>
    | undefined;
  const donorMetrics = deriveDonorAggregateMetrics(validationRuns);

  const donorDsr = donorMetrics?.meanDsrProbability ?? null;
  const donorDsrThreshold = 0.5;
  criteria.push({
    id: "C1_donor_dsr_feasible",
    description: `Donor-only DSR approaching ${donorDsrThreshold} (currently: ${donorDsr?.toFixed(3) ?? "n/a"})`,
    status:
      donorDsr !== null
        ? donorDsr >= donorDsrThreshold
          ? "pass"
          : donorDsr >= 0.4
            ? "inconclusive"
            : "fail"
        : "inconclusive",
    evidence:
      donorDsr !== null
        ? `Donor DSR = ${donorDsr.toFixed(4)} (threshold: ${donorDsrThreshold})`
        : "Donor metrics unavailable.",
  });

  const donorPbo = donorMetrics?.meanPbo ?? null;
  criteria.push({
    id: "C2_pbo_declining",
    description: `PBO declining toward < 0.5 (currently: ${donorPbo?.toFixed(3) ?? "n/a"})`,
    status:
      donorPbo !== null
        ? donorPbo < 0.2
          ? "pass"
          : donorPbo < 0.5
            ? "inconclusive"
            : "fail"
        : "inconclusive",
    evidence:
      donorPbo !== null
        ? `Donor PBO = ${donorPbo.toFixed(4)} (target: < 0.5, hard threshold: 0.2)`
        : "PBO unavailable.",
  });

  const aggregateWfoFailure = toFiniteNumber(
    aggregateMetrics?.wfoFailureDensity ??
      (validationRuns.portfolio as Record<string, unknown> | undefined)?.wfoFailureDensity,
  );
  criteria.push({
    id: "C3_wfo_improving",
    description: `WFO failure density < 50% (currently: ${
      aggregateWfoFailure !== null
        ? `${(aggregateWfoFailure * 100).toFixed(1)}%`
        : "n/a"
    })`,
    status:
      aggregateWfoFailure !== null
        ? aggregateWfoFailure < 0.3
          ? "pass"
          : aggregateWfoFailure < 0.5
            ? "inconclusive"
            : "fail"
        : "inconclusive",
    evidence:
      aggregateWfoFailure !== null
        ? `WFO failure density = ${(aggregateWfoFailure * 100).toFixed(1)}% (target: < 50%)`
        : "WFO metrics unavailable.",
  });

  if (wfoSensitivity) {
    const wfoProfiles = Array.isArray(wfoSensitivity.profiles)
      ? wfoSensitivity.profiles
      : [];
    const hasStableProfile = wfoProfiles.some((profile: unknown) => {
      if (!isPlainObject(profile)) {
        return false;
      }
      const candidates = Array.isArray((profile as Record<string, unknown>).candidates)
        ? (profile as Record<string, unknown>).candidates
        : [];
      return candidates.some(
        (candidate: unknown) =>
          isDonorRecord(candidate) &&
          Array.isArray((candidate as Record<string, unknown>).diagnosisHints) &&
          !(candidate as Record<string, unknown>).diagnosisHints.some(
            (hint: unknown) =>
              typeof hint === "string" && hint.includes("high_window_failure"),
          ),
      );
    });
    criteria.push({
      id: "C4_wfo_stable_profile_exists",
      description: "At least one WFO profile shows stable donor performance",
      status: hasStableProfile ? "pass" : "fail",
      evidence: hasStableProfile
        ? "Found WFO profile with stable donor performance."
        : "No WFO profile shows stable donor — high failure density across all window designs.",
    });
  } else {
    criteria.push({
      id: "C4_wfo_stable_profile_exists",
      description: "WFO sensitivity data available",
      status: "inconclusive",
      evidence: "No WFO sensitivity data provided.",
    });
  }

  return {
    stage: "C",
    label: "Robust Admission Feasibility",
    status: deriveStageStatus(criteria, [
      "C1_donor_dsr_feasible",
      "C2_pbo_declining",
      "C3_wfo_improving",
      "C4_wfo_stable_profile_exists",
    ]),
    criteria,
  };
}

function assessStageD(
  validationRuns: Record<string, unknown> | null,
  _routeMatrix: Record<string, unknown> | null,
): TradingAgentsStageAssessment {
  const criteria: TradingAgentsStageCriterion[] = [];

  if (!validationRuns) {
    return {
      stage: "D",
      label: "Paper Profitability",
      status: "inconclusive",
      criteria: [
        {
          id: "data",
          description: "Data available",
          status: "inconclusive",
          evidence: "No data.",
        },
      ],
    };
  }

  const formalResult =
    typeof validationRuns.result === "string" ? validationRuns.result : null;
  const isGo = formalResult === "GO" || formalResult === "GO_PAPER";
  criteria.push({
    id: "D1_formal_verdict_go",
    description: "Formal validation verdict is GO or GO_PAPER",
    status: isGo ? "pass" : "fail",
    evidence: `Formal result: ${formalResult ?? "unknown"}`,
  });

  const portfolio = validationRuns.portfolio as Record<string, unknown> | undefined;
  const releaseGate = portfolio?.releaseGate as Record<string, unknown> | undefined;
  const allowPaper = releaseGate?.allowPaperTrading === true;
  criteria.push({
    id: "D2_release_gate_paper",
    description: "Release gate allows paper trading",
    status: allowPaper ? "pass" : "fail",
    evidence: allowPaper
      ? "Paper trading allowed."
      : `Paper trading blocked. Failed checks: ${JSON.stringify(
          releaseGate?.failedChecks ?? [],
        )}`,
  });

  const aggregateMetrics = validationRuns.aggregateMetrics as
    | Record<string, unknown>
    | undefined;
  const meanPbo = toFiniteNumber(aggregateMetrics?.meanPbo);
  const meanDsr = toFiniteNumber(aggregateMetrics?.meanDsrProbability);
  const fdrQ = toFiniteNumber(aggregateMetrics?.fdrQ);
  const metricsPass =
    meanPbo !== null &&
    meanPbo <= 0.2 &&
    meanDsr !== null &&
    meanDsr >= 0.5 &&
    fdrQ !== null &&
    fdrQ <= 0.1;
  criteria.push({
    id: "D3_aggregate_metrics_pass",
    description: "All aggregate metrics pass thresholds",
    status: metricsPass ? "pass" : "fail",
    evidence: `PBO=${meanPbo?.toFixed(3) ?? "n/a"} (≤0.2), DSR=${
      meanDsr?.toFixed(3) ?? "n/a"
    } (≥0.5), FDR=${fdrQ?.toFixed(3) ?? "n/a"} (≤0.1)`,
  });

  return {
    stage: "D",
    label: "Paper Profitability",
    status: deriveStageStatus(criteria, [
      "D1_formal_verdict_go",
      "D2_release_gate_paper",
      "D3_aggregate_metrics_pass",
    ]),
    criteria,
  };
}

function deriveStageStatus(
  criteria: TradingAgentsStageCriterion[],
  requiredIds: string[],
): TradingAgentsStageStatus {
  const required = criteria.filter((criterion) => requiredIds.includes(criterion.id));
  if (required.some((criterion) => criterion.status === "fail")) {
    return "fail";
  }
  if (required.some((criterion) => criterion.status === "inconclusive")) {
    return "inconclusive";
  }
  return "pass";
}

function determineCurrentStage(
  stages: TradingAgentsStageAssessment[],
): TradingAgentsStage {
  const stageOrder: TradingAgentsStage[] = ["A", "B", "C", "D"];
  for (let index = stageOrder.length - 1; index >= 0; index -= 1) {
    const stage = stageOrder[index];
    const current = stages.find((item) => item.stage === stage);
    const priorStages = stageOrder.slice(0, index);
    const priorAllPass = priorStages.every((priorStage) => {
      const prior = stages.find((item) => item.stage === priorStage);
      return prior?.status === "pass";
    });
    if (priorAllPass && current?.status === "pass") {
      return stage;
    }
  }
  for (const stage of stageOrder) {
    const current = stages.find((item) => item.stage === stage);
    if (current && current.status !== "pass") {
      return stage;
    }
  }
  return "A";
}

function buildRecommendation(
  currentStage: TradingAgentsStage,
  currentStatus: TradingAgentsStageStatus,
  stages: TradingAgentsStageAssessment[],
): string {
  const stage = stages.find((item) => item.stage === currentStage);
  if (!stage) {
    return "Unable to determine current stage.";
  }

  const failedCriteria = stage.criteria.filter((criterion) => criterion.status === "fail");
  if (currentStatus === "pass") {
    const nextStage: Record<TradingAgentsStage, TradingAgentsStage | null> = {
      A: "B",
      B: "C",
      C: "D",
      D: null,
    };
    const next = nextStage[currentStage];
    return next
      ? `Stage ${currentStage} passed. Ready to begin work toward Stage ${next}.`
      : "All stages passed. Ready for paper-to-live execution pathway.";
  }

  if (failedCriteria.length === 0) {
    return `Stage ${currentStage} has inconclusive criteria. Gather more data to resolve.`;
  }

  const failedIds = failedCriteria.map((criterion) => criterion.id).join(", ");
  switch (currentStage) {
    case "A":
      return `Stage A not met. Donor does not reliably beat BASELINE_CONTROL. Failed: ${failedIds}. Focus on improving donor signal quality or adjusting donor parameters.`;
    case "B":
      return `Stage B not met. Donor does not maintain superiority against stronger controls. Failed: ${failedIds}. Try baseline_robust_anchor_v1 or baseline_independent_guard_v1 pools to identify whether the issue is control design or genuine signal weakness.`;
    case "C":
      return `Stage C not met. Aggregate metrics not yet in admission-feasible range. Failed: ${failedIds}. Focus on WFO stability and PBO reduction — these are the highest-leverage improvements.`;
    case "D":
      return `Stage D not met. Formal admission gates still blocking. Failed: ${failedIds}. Address remaining threshold failures before paper trading.`;
  }
}

function extractDonorCandidates(
  validationRuns: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const symbols = Array.isArray(validationRuns.symbols) ? validationRuns.symbols : [];
  return symbols.flatMap((symbol: unknown) => {
    if (!isPlainObject(symbol) || !Array.isArray(symbol.candidates)) {
      return [];
    }
    return symbol.candidates.filter((candidate: unknown) => isDonorRecord(candidate)) as Array<
      Record<string, unknown>
    >;
  });
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isDonorRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.role === "donor") {
    return true;
  }
  const strategyId = typeof value.strategyId === "string" ? value.strategyId : "";
  const familyKey = typeof value.familyKey === "string" ? value.familyKey : "";
  return strategyId.includes("TA_DONOR") || familyKey.includes("tradingagents_donor");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

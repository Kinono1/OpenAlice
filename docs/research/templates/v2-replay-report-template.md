# V2 Protocol Replay Report Template

Use this template for baseline-vs-replay analysis when running V2 protocol on the latest code.

## Metadata

- runId:
- generatedAt:
- baselineRoot:
- replayRoot:
- baselineSummaryPath:
- replaySummaryPath:
- baselineCompletionPath:
- replayCompletionPath:

## Protocol Consistency Checklist

- [ ] objectiveMetric is `accuracyLift` for replay training.
- [ ] labelingMode is `next_return_sign` for replay training.
- [ ] NAS is disabled for replay run.
- [ ] includeModels excludes new models not present in original V2 baseline.
- [ ] completion objective is `accuracyLift` (`objectiveMode=max`).

## Training Metrics Comparison

| Metric | Baseline | Replay | Delta |
|---|---:|---:|---:|
| meanDirectionAccuracy |  |  |  |
| meanBaselineDirectionAccuracy |  |  |  |
| meanAccuracyLift |  |  |  |
| positiveLiftRatio |  |  |  |
| meanObjectiveScore |  |  |  |

## Completion Metrics Comparison

| Metric | Baseline | Replay | Delta |
|---|---:|---:|---:|
| score |  |  |  |
| readiness |  |  | n/a |
| paperPassRatio |  |  |  |
| livePassRatio |  |  |  |
| significancePassRatio |  |  |  |
| meanPbo |  |  |  |
| meanDsrProbability |  |  |  |
| hardGateApplied |  |  | n/a |

## Failure Attribution (Model vs System)

- Model-side evidence:
- Validation-protocol evidence:
- Tooling/auth/environment gate evidence:
- Data-quality/preprocessing evidence:

## Decision

- [ ] Evidence supports model regression.
- [ ] Evidence supports protocol/system change as dominant factor.
- [ ] Evidence inconclusive; run extra controlled replay.

## Next Actions

1. 
2. 
3. 

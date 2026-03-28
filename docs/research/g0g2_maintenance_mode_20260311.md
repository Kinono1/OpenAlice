# G0-G2 Maintenance Mode Declaration

Date: `2026-03-11`

## 1. Decision

`G0`、`G1`、`G2` 自本日进入维护态。

这表示：

- these gates are no longer the primary research bottleneck
- they remain required for every serious run
- they accept bug fixes and reliability fixes
- they do not accept new feature work unless that feature is required to keep the existing checks truthful

## 2. Baseline Status

| Gate | Status | Summary | Source |
| --- | --- | --- | --- |
| `G0` | `pass` | `4/4` passed | `decision_packet/gates/G0.checkpoint.json` |
| `G1` | `pass` | `3/3` passed | `decision_packet/gates/G1.checkpoint.json` |
| `G2` | `pass` | `8/8` passed | `decision_packet/gates/G2.checkpoint.json` |

Detail snapshot:

- `G0`
  - `env:verify` exists and passes
  - `freeze:verify` exists and passes
- `G1`
  - preflight report exists
  - final exit code is `0`
  - preflight steps all pass
- `G2`
  - research quality report exists
  - `paperCount=10`
  - `paperCardSchemaPassRate=1.0`
  - `missingRequiredFields=0`
  - `evidenceLinkRate=1.0`
  - `contracts.passed=true`

## 3. What Maintenance Mode Means

Allowed work:

- bug fixes that restore the truthfulness of current checks
- schema or parser fixes needed to keep existing artifacts valid
- reliability fixes that keep the current gate outputs reproducible

Disallowed as primary work:

- new feature development centered on `G0-G2`
- new quality metrics unless needed by `Stage-C`
- broader governance-system expansion that does not change the `G3` bottleneck

## 4. Priority Rule

If a new runtime or research issue appears, prioritize as follows:

1. `G3` blockers
2. runtime issues that break truthful execution or observability
3. maintenance-only fixes for `G0-G2`

This means `G0-G2` are not abandoned, but they are no longer the primary frontier.

## 5. Current Research Implication

The active frontier is:

- `Stage-C` signal rebuild
- `CORE7`-driven candidate generation
- multi-asset evaluation aimed at improving `G3`

The maintenance-mode justification is simple:

- `G0-G2` are green
- `G3` is red
- therefore the main research budget should move away from governance plumbing and into candidate quality

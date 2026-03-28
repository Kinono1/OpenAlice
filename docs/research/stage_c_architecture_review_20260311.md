# Stage-C Architecture Review

Date: `2026-03-11`

## Decision Question

What single direction should replace the current failed Stage-C iteration path?

## Inputs

- `stage_c_arch_review_signal_audit_20260311.md`
- `stage_c_arch_review_horizon_20260311.md`
- `stage_c_arch_review_candidate_design_20260311.md`
- `stage_c_arch_review_methodology_20260311.md`
- `stage_c_sprint2_note_20260311.md`

## Decision Options

### Option A — `candidate_redesign`

Rejected.

Reason:

- candidate redesign alone was already attempted via the more conservative `v2` path
- results became worse, not better
- current evidence suggests target mismatch is upstream of candidate choice

### Option B — `feature_horizon_redesign`

Selected.

Reason:

- surviving signal still exists
- current candidate layer fails to translate it
- methodology gives no rescue value
- the most evidence-backed next move is to redesign the target / horizon mapping before any new family expansion
- the new target scan points to `realized_vol_1h` as the strongest next target, not direct fixed-horizon return

### Option C — `pipeline_bug_reopen`

Rejected.

Reason:

- there is no current hard evidence that the evaluation chain is the primary failure source
- the observed collapse is better explained by candidate/target mismatch than by a broken gate pipeline

## Single Conclusion

Selected next direction: `feature_horizon_redesign`

## Required Consequences

- freeze Workstream A family expansion
- freeze Workstream B as a parked sidecar
- do not generate `v3` candidates yet
- do not update `decision_packet`

## Next Research Sprint Definition

The next research sprint must do exactly this:

- redesign the prediction target / aggregation mapping around `realized_vol_1h` first
- re-evaluate the surviving feature families under that new mapping
- only after that, authorize a new single-seed candidate family

## Not Selected

The next sprint is **not**:

- a broader parameter sweep
- a more complex methodology sprint
- a live rollout sprint

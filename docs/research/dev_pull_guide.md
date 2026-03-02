# OpenAlice Dev Pull Guide

Updated: 2026-03-02

## Scope

This guide is for pulling the latest `dev` branch updates from the personal remote:

- Remote: `kino`
- Branch: `dev`

## 1) Pull Latest Dev

```bash
git fetch kino
git checkout dev
git pull --ff-only kino dev
```

## 2) Runtime Profile for Governance Checks

The current environment lock targets:

- Python `3.13.x`
- Node `22.21.x`
- pnpm `10.29.x`

Use the local runtime wrapper if your shell defaults are newer:

```bash
export PATH=/tmp/openalice-runtime-lock/bin:$PATH
python3 --version
node -v
pnpm -v
```

## 3) Required Validation Commands

```bash
pnpm run env:verify
pnpm run freeze:verify
pnpm run gates:preflight
python3 scripts/tests/test_governance_pipeline.py
pnpm exec vitest run src/backtest/statistical_significance.spec.ts \
  src/backtest/release_gate.spec.ts \
  src/extension/strategy-tools/adapter.integration.spec.ts \
  src/backtest/fdr.spec.ts
```

Expected for this cycle:

- Governance commands should exit `0`.
- Test commands should pass.

## 4) Full V5 Closed-Loop (Optional)

```bash
pnpm run research:mvp
pnpm run strategy:mvp
pnpm run gates:checkpoints
pnpm run decision:build
pnpm run decision:validate
```

Expected:

- `strategy:mvp` may return `2` (`NO_GO`) by design.
- `decision:validate` may return `2` (`NO_GO`) by design.
- Artifact traceability must still be complete.

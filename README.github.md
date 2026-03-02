# OpenAlice Branch README: dev

## Branch Identity

- Branch name: `dev`
- Role: integration and validation branch.
- Purpose: receive reviewed changes from work branches and verify branch-level stability.

## What This Branch Is For

- Integrate changes from `work/*` branches.
- Run integration-level checks before promotion.
- Keep branch policy and governance checks green.

## Recommended Workflow

1. Merge verified work-branch changes into `dev`.
2. Run integration and governance checks on `dev`.
3. Confirm no integration breakage before moving to upstream release flow.

## Notes

- This file is branch-specific and intended to be visible when browsing this branch on GitHub.
- Main project documentation remains in `README.md`.

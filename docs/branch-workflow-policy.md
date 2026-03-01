# Branch Workflow Policy (v1)

This repository uses a fixed three-branch workflow defined in:

- `data/config/branch_workflow.v1.json`

## Branch Roles

- `master`: official upstream sync branch (`origin/master` mirror only)
- `work/kino-mainline`: primary algorithm/product development branch
- `dev`: integration branch for combining `master` and `work/kino-mainline`

## Merge Rules

Allowed:

- `master -> dev`
- `work/kino-mainline -> dev`
- `dev -> work/kino-mainline`

Forbidden:

- `work/kino-mainline -> master`
- `master -> work/kino-mainline`
- `dev -> master`

## Standard Loop

1. Develop on `work/kino-mainline` (or short-lived feature branches merged back into it).
2. Sync official updates on `master`.
3. Integrate both in `dev`, run validation/tests.
4. If green, merge `dev` back into `work/kino-mainline`.
5. Keep `master` clean as upstream mirror.

## Policy Commands

```bash
pnpm branch:policy:show
pnpm branch:policy:check
pnpm branch:policy:can-merge -- --source work/kino-mainline --target dev
```

Notes:

- `branch:policy:check` validates current branch is one of the configured workflow branches.
- `branch:policy:can-merge` validates a merge direction against configured allow/deny rules.

## Forced Enforcement (pre-push hook)

Install hooks once per clone:

```bash
pnpm branch:policy:install-hooks
```

This sets `core.hooksPath=.githooks` and enables `.githooks/pre-push`, which enforces:

- Unknown branch blocking (`blockUnknownBranches`)
- Forbidden push directions
- Allowed push directions
- Branch-to-remote role policy (`official` vs `personal`)

Manual simulation example:

```bash
echo "refs/heads/work/kino-mainline abc refs/heads/master def" | pnpm branch:policy:enforce-push -- --remote-name kino
```

The command exits with `2` when policy is violated.

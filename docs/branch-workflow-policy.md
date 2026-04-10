# Branch Workflow Policy (Forward-Port v1)

This repository currently uses a three-branch workflow defined in:

- `data/config/branch_workflow.v1.json`

## Branch Roles

- `master`: official upstream sync branch (`origin/master` mirror only)
- `work/kino-mainline`: primary product and strategy development branch
- `integrate/master-forward-port-20260403`: forward-port and validation branch for rebuilding `work/kino-mainline` behavior on the latest `master` architecture

## Merge Rules

Allowed:

- `master -> integrate/master-forward-port-20260403`
- `work/kino-mainline -> integrate/master-forward-port-20260403`
- `integrate/master-forward-port-20260403 -> work/kino-mainline`

Forbidden:

- `work/kino-mainline -> master`
- `master -> work/kino-mainline`
- `integrate/master-forward-port-20260403 -> master`

## Standard Loop

1. Sync official upstream updates on `master`.
2. Continue feature and algorithm work on `work/kino-mainline`.
3. Rebuild and validate missing capability on `integrate/master-forward-port-20260403`.
4. When parity is complete and validated, merge the forward-port branch back into `work/kino-mainline`.
5. Only then reassess whether a raw merge is still useful.

## Policy Commands

```bash
pnpm branch:policy:show
pnpm branch:policy:check
pnpm branch:policy:can-merge -- --source work/kino-mainline --target integrate/master-forward-port-20260403
```

Notes:

- `branch:policy:check` validates the current branch against configured workflow branches.
- `branch:policy:can-merge` validates a merge direction against configured allow/deny rules.

## Pre-Push Enforcement

Install hooks once per clone:

```bash
pnpm branch:policy:install-hooks
```

This enables `.githooks/pre-push`, which enforces:

- unknown branch blocking
- forbidden push directions
- allowed push directions
- branch-to-remote role policy

Manual simulation example:

```bash
echo "refs/heads/work/kino-mainline abc refs/heads/master def" | pnpm branch:policy:enforce-push -- --remote-name kino
```

The enforcement command exits with `2` when policy is violated.

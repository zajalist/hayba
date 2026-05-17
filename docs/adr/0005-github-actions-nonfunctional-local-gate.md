# 0005 — GitHub Actions is non-functional; the local gate is authoritative

**Status:** Accepted (2026-05-17)

## Context

Every GitHub Actions run for this repository fails with zero step output
— runners are assigned but never execute. This holds on `main` too,
including the merge commits of PRs that were merged anyway (#134, #112,
#113, #136). It is an account/runner/billing-level condition, not a code
defect. "CI green" is therefore unachievable here regardless of code.

## Decision

Treat GitHub Actions as **non-functional**. Do not block work on it. The
**authoritative gate is local**:

```
npm install
npm run -w @hayba/linguistics build      # + @hayba/architecture, @hayba/planet-physics
npm --prefix mcp-tools/hayba-mcp test     # tsc --noEmit + vitest
```

A change is "green" when that passes locally. The CI workflow is kept
(correct for the layout, Node 22) so it works if Actions is ever
restored.

## Consequences

- PRs may be merged with red GitHub checks; reviewers rely on the local
  gate result reported in the PR.
- Contributors must run the gate locally before pushing.
- Revisit if/when Actions is restored at the account level.

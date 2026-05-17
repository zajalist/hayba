# 0001 — Monorepo restructure + re-emulation doctrine

**Status:** Accepted (2026-05-17)

## Context

The repo was restructured (`packages/hayba` → `mcp-tools/hayba-mcp`,
`apps/`, workspace globs; PR #136). Several feature branches (PRs
#110/#112/#113/#134, and `feat/website-integration`) diverged *before*
the restructure. Their trees are the old layout. Git-merging them into
restructured `main` causes massive conflicts and reintroduces the old
file layout — re-doing the work the restructure deleted.

## Decision

When a pre-restructure branch's behaviour must land on `main`, **reproduce
its effect as fresh commits on the restructured layout** (re-emulation).
Do **not** git-merge the old-layout branch. Where the restructure already
superseded a branch's change (e.g. the architecture half of #112,
`feat/website-integration`'s `packages/`), **do not re-apply it** — the
restructured version wins. Original branches stay merged in history; we
reproduce effect, not diffs.

## Consequences

- Incorporation is content re-emulation + verification, never a 4-way
  merge. Slower per-PR but keeps the restructure intact.
- Each re-emulation must be verified by the local gate (ADR-0005), not by
  diffing against the original (paths differ by design).
- Surfaced, superseded behaviour is documented (here / in commit
  messages) rather than silently dropped.

# 0005 — Split the tectonic stack into the hayba-explorer repo

**Status:** Accepted (2026-06-12)

## Context

The monorepo carried two products with disjoint toolchains and release
cadences: (a) the MCP server + UE5 plugin + website, and (b) the tectonic
plate simulation (Rust crates) + its Tauri desktop viewer + sim tooling.
The Rust workspace, `viz/`, and the sim audit tools existed solely for
(b), while the protocol seam (`mcp-tools` ↔ `unreal`) and the website
never touched them. The maintainer decided to break the monorepo.

## Decision

Move the tectonic stack to <https://github.com/zajalist/hayba-explorer>,
extracted with `git filter-repo` so the full sim commit history (and 14
in-flight sim branches, including the unpushed
`feat/lagrangian-particle-foundation`) survives. The explorer was lifted
from `apps/hayba-explorer/` to that repo's root.

Moved: `apps/hayba-explorer` (app + `fixedpoint`/`seeds`/`tectonics`
Rust crates + `frame-stream`), `packages/design-tokens` (the explorer is
its only consumer), `viz/`, `tools/peels-audit`, `tools/derive_satmaps`,
root `Cargo.toml`/`Cargo.lock`.

Stayed (relocated): `@hayba/linguistics` and `@hayba/planet-physics`
moved from `apps/hayba-explorer/packages/` to `packages/` because
`mcp-tools/hayba-mcp` imports them — the relocation landed in the same
commit as the removal so the workspace never broke.

Deleted: `_archive/hayba-tectonics-v1` (superseded; git history keeps it).

## Consequences

- This repo has no Rust toolchain; the cargo dependabot block is gone.
- The deferred linguistics→Explorer integration (ADR-0003) is cross-repo.
- The untracked private notes under `docs/superpowers|briefs|research`
  were copied (not git-moved — they were never tracked) into the new
  repo for the tectonic subset; originals remain on the maintainer's disk.
- The retired `tectonic-explorer/` working copy (own embedded `.git`)
  was parked outside both repos at `D:\Hackathons\tectonic-explorer`.

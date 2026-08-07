# 0005 — Tectonic stack split out to `hayba-explorer`

**Status:** Accepted (2026-06-12) · reconstructed 2026-08-07

## Context

`CHANGELOG.md` cites ADR-0005 as the authority for the repo split, but the file
was not in `docs/adr/`. It went with the code it described: the split moved the
tectonic stack — the simulation, the Hayba Explorer Tauri viewer, `viz/`, sim
audit tooling, `design-tokens` and the Rust workspace — to
[hayba-explorer](https://github.com/zajalist/hayba-explorer) with full history,
and the ADR travelled with them.

The result was a dangling citation. The one document whose job is to stop a
decision being re-litigated pointed at nothing, in the repo where the decision
still constrains the layout. ADR-0003 is absent for the same reason
(thickness-relaxation orogeny — a tectonics decision that correctly belongs to
the other repo), which is why the numbering here reads 0001, 0002, 0004, 0005.

This file records the split **from this side**: what left, what stayed, and what
that implies for anyone working here. It is a reconstruction, not the original.

## Decision

The tectonic/worldbuilding simulation stack lives in `zajalist/hayba-explorer`.
This repo keeps the agentic UE toolchain:

- `mcp-tools/hayba-mcp` — the Node MCP server (the protocol's Node adapter)
- `unreal/HaybaMCPToolkit` — the UE5 C++ plugin (the protocol's C++ adapter)
- `packages/` — `@hayba/linguistics`, `@hayba/planet-physics`, `@hayba/architecture`,
  which stayed because the MCP server imports them
- `website/`, `supabase/`, `infra/`

An ADR that describes code moving **out** of a repo belongs in both repos: the
receiving one to explain where the code came from, the sending one to explain
why it is not here. Copy it, do not move it.

## Consequences

- Root workspaces are `packages/*` + `mcp-tools/hayba-mcp` (narrowed from
  `mcp-tools/*` on 2026-08-07 — the glob matched four directories of which one
  had a manifest).
- Residue outlived the split and had to be cleaned up separately: `apps/`
  survived as 1,160 untracked files of `dist/` and `node_modules/` with no
  source, three `hayba-explorer-*` tags still point into this repo's history,
  and ~30 labels describing the worldbuilding taxonomy remain on closed issues.
- The explorer's objects are still reachable in this repo's history, which is
  most of why `.git` is ~3.6 GB while the working tree is a small fraction of
  that.

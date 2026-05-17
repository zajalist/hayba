# 0004 — UE plugin lives at `unreal/HaybaMCPToolkit/`

**Status:** Accepted (2026-05-17)

## Context

The UE5 C++ plugin (the TCP-server **adapter** on the protocol seam)
lived only in an external geoforge project tree, with its own
non-authoritative local git history. It must be in the monorepo so both
adapters of the TCP seam are versioned together. Options considered:
nest under `mcp-tools/hayba-mcp/` (physical adapter co-location), or a
conventional top-level directory.

## Decision

Import to **top-level `unreal/HaybaMCPToolkit/`** as a snapshot (Source/
+ Resources/ + `.uplugin` only; build artifacts gitignored). Geoforge
history is discarded (single snapshot commit) — the monorepo copy is
canonical. Adapter co-location with `mcp-tools/hayba-mcp` is expressed
via **cross-linked READMEs + CONTEXT.md**, not physical nesting (a C++ UE
plugin under a Node tool package would mislead tooling and contributors).

## Consequences

- Both TCP-seam adapters now evolve in one repo; protocol changes stop
  being cross-repo lockstep.
- `unreal/` clearly signals "the UE integration" in an otherwise
  JS/TS/Rust repo.
- Plugin build artifacts are gitignored; UBT regenerates them.
- Future UE modules/plugins also go under `unreal/`.

# The Sealed Vault — Solvability-Guaranteed Lock/Key Dungeon (PCGEx Showcase)

**Date:** 2026-05-19
**Status:** Approved (concept) — pending written-spec review
**Author:** Badr (with Claude)
**Branch:** `showcase/pcgex-sealed-vault`

## Overview

A PCGEx showcase that generates a multi-room dungeon whose progression is
**provably solvable by construction**: every key is reachable, from the
entrance, *strictly before* the lock it opens, with no soft-locks. The
solvability proof is not gameplay code — it is a topological-ordering argument
expressed entirely in PCGEx cluster/flood-fill nodes.

The showcase is authored live in a running UE5 editor through the Hayba MCP
toolkit, under Plan Mode (every mutation wrapped in an editor transaction so
Ctrl+Z reverts the whole graph).

## Why this is a meaningful PCG demonstration

Typical "procedural dungeon" demos stop at spatial layout (rooms + corridors).
The genuinely hard problem is **progression integrity**: guaranteeing the
player can always finish. Naive key/lock placement produces unsolvable layouts
(key sealed behind the lock it opens) or trivial ones. We guarantee solvability
using a reachability rank derived from a flood fill over the room graph, then
constrain key placement to that rank ordering. This exercises the deepest part
of the PCGEx cluster system rather than just its point scatter.

## Core invariant (the proof obligation)

Let the dungeon be a connected graph `G = (R, E)` of rooms `R` and traversable
connections `E`, with a designated `entrance ∈ R`.

1. Compute `rank: R → ℕ` = BFS distance from `entrance` over `E` **before any
   locks are applied** (`Cluster : Flood Fill` seeded at `entrance`).
2. Process locked edges in ascending `rank` of their near endpoint. For a lock
   placed on edge `(u, v)` with `rank(u) ≤ rank(v)`, its key MUST be placed in
   a room `k` with `rank(k) ≤ rank(u)` **and** `k` reachable without crossing
   any not-yet-openable lock (verified by re-running flood fill on the
   "currently openable" subgraph).
3. The exit/boss room is the argmax-rank room; the last key's lock gates it.

Because each key sits at a rank no deeper than the lock it opens, and locks are
introduced in rank order, there is always a monotone path
`entrance → … → boss` that collects each key before reaching its lock. This is
a constructive topological order over the lock-dependency DAG. Soft-locks
(e.g., one-way drops) are explicitly excluded so the DAG stays acyclic.

## Pipeline (every node verified against `pcgex_registry.db`, 344 nodes)

| # | Stage | PCGEx node(s) (`display_name`) | Output |
|---|-------|--------------------------------|--------|
| 1 | Room seeds | native PCG point sampling in a bounded volume → `Lloyd Relax 2D` (1–2 iterations) | ~14 evenly spaced room centers |
| 2 | Candidate adjacency | `Cluster : Delaunay 2D` | planar, non-crossing connection graph |
| 3 | Connected spine | `Refine : Edges` (`UPCGExRefineEdgesSettings`) in **Minimum Spanning Tree** mode | tree guaranteeing full connectivity |
| 4 | Loops | re-introduce *k* (≈3) shortest non-tree Delaunay edges via `Cluster : Sanitize` + filtered merge | a few cycles so it is not a pure tree |
| 5 | **Reachability rank** | `Cluster : Flood Fill` seeded at `entrance` vtx | `Rank` int attribute per room vtx |
| 6 | **Lock/key placement** | `Cluster : Partition Vtx` / `Partition by Values` over `Rank`; `Action : Write Attributes` to stamp `LockId` / `KeyId` | N color-coded keys + N locked edges satisfying the core invariant |
| 7 | Room footprints | `Pathfinding : Find Cells` over the planar graph | per-room polygon cells (floor footprints) |
| 8 | Corridors | `Pathfinding : Plot Edges` + `Heuristics Definition` (`Heuristics : Shortest Distance`) → `Path : Subdivide` / `Path : Resample` | carved corridor splines between connected rooms |
| 9 | Role dressing | `Partition by Values` on room role + native ISM/static-mesh scatter | instanced props per role: entrance / key / lock / treasure / boss |

### Attribute contract (data flowing on the cluster)

- `Rank: int32` — BFS depth from entrance (stage 5). Read-only after stage 5.
- `RoomRole: name` — one of `entrance | hub | key | lock | treasure | boss`
  (stage 6/9).
- `KeyId: int32` — `-1` if none; else the key color index held in this room.
- `LockId: int32` — on **edges**; `-1` if open; else the key index that opens
  this edge. Invariant checked: for every edge with `LockId = i`, there exists
  a vtx with `KeyId = i` and `Rank ≤ Rank(near endpoint of that edge)`.

## Execution via Hayba MCP

1. `list_tool_categories` → `get_tool_signature` for the PCG domain (Code Mode
   meta-tools keep the payload small).
2. Query the PCGEx SQLite registry through the server for each node's exact
   class + pins + properties before wiring (no guessed node names).
3. Author the graph in a **new PCG graph asset** in the open project; spawn a
   PCG volume actor in the level to drive it.
4. Wrap the whole authoring sequence in Plan Mode → one
   `GEditor->BeginTransaction`, so a single Ctrl+Z reverts the entire showcase.
5. Execute the graph; read back the resulting point/edge attribute tables.

## Validation strategy

Per the project rule *validate visually, not just metric counts*:

1. **Invariant assertion (structural):** read the edge table; for every locked
   edge assert a key vtx exists with `Rank ≤ Rank(near endpoint)`. Re-run a
   flood fill restricted to currently-openable edges and assert the boss room
   is reachable. Fail loud if violated.
2. **Topology sanity:** assert graph is connected, has ≥ *k* cycles, room
   count in `[12, 16]`, exactly one entrance and one boss.
3. **Visual:** viewport screenshot from top-down; confirm rooms are
   non-overlapping, corridors connect, role props are placed, locks/keys
   visible. Inspect, don't just count.

## Testing

- **Determinism:** fixed seed → identical graph across two runs (hash the
  sorted edge + attribute table).
- **Invariant fuzz:** run generation for seeds 1..25; the structural invariant
  assertion must pass for **every** seed (this is the real test of the
  showcase, not the visuals).
- **Revert:** single Ctrl+Z removes all spawned actors + the PCG asset.

## Out of scope (YAGNI)

- Gameplay (no playable character, no actual door logic at runtime).
- 3D / multi-floor dungeons (2D planar graph only).
- Soft-locks, one-way edges, optional-content side quests.
- Persisting/exporting the dungeon as a reusable level asset.
- Art polish beyond role-indicative ISM placeholders.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Hayba MCP tools not loaded into agent session | Connection repaired + `✓ Connected`; requires one Claude Code restart before execution (documented prerequisite). |
| `Refine : Edges` MST mode option name differs from assumption | Query the registry's `properties` table for the exact enum before wiring; do not hardcode. |
| Flood Fill seed selection ambiguous | Explicitly tag the entrance vtx via `Action : Write Attributes` and seed Flood Fill from that filtered vtx set. |
| Invariant violated for some seed | Fuzz seeds 1..25 in testing; if any fails, the placement constraint in stage 6 is wrong — fix before claiming success. |

## References

- PCGEx registry: `D:/UnrealEngine/geoforge/Plugins/HaybaMCPToolkit/Resources/pcgex_registry.db`
- Related: `docs/superpowers/specs/2026-04-14-pcgex-dspy-gnn-design.md` (graph-gen system this showcase exercises by hand)

/**
 * PCGEx graph-building patterns, anti-patterns, and node usage rules.
 * Loaded by the system prompt / tool descriptions to prevent known mistakes.
 */

export const GRAPH_PATTERNS = `
# PCGEx Graph Building — Known Rules & Anti-Patterns

## Seeds / Goals (PCGExPathfindingEdgesSettings)
- Seeds and Goals pins expect ANY point data in space — they do NOT require actor references.
- DO NOT use PCGDataFromActorSettings for seeds/goals by default.
  Reason: defaults to @Last (self), so both nodes return the same actor → zero-distance path → error.
- DO use PCGSurfaceSamplerSettings with low density (e.g. PointsPerSquaredMeter=0.0001)
  and different Seed values (e.g. 42 and 999) to get two distinct surface points as start/end.
- If actor-based points are truly needed, the user must manually configure ActorSelector
  in the PCG editor — the MCP cannot reliably set struct properties like ActorSelector.

## PCGExSmoothSettings
- Smooth is DEAD WEIGHT without Blend Ops wired into the "Blend Ops" input pin.
- DO NOT add PCGExSmoothSettings to a graph unless Blend Ops are also provided.
- If smoothing is desired, either omit it (let the user add it manually with ops)
  or document that the user must wire a blend op factory node into it.

## Path node pin names
- PCGEx path nodes (Pathfinding, Smooth, CreateSpline, etc.) use "Paths" for both input and output.
- DO NOT use "In" or "Out" for these nodes — they will fail validation.
- Standard PCG nodes (SurfaceSampler, GetLandscape, etc.) still use "In" / "Out".

## PCGDataFromActorSettings
- Mode defaults to ParseActorComponents — returns empty if actor has no relevant components.
- For a single position point, set Mode = GetSinglePoint.
- Both nodes in a graph will reference @Last (self) unless ActorSelector is manually configured.
  Prefer surface samplers or graph input pins instead for seeds/goals.

## Heuristics
- PCGExHeuristicsShortestDistanceProviderSettings output pin is "Heuristics".
- Wire it into the "Heuristics" input pin of PCGExPathfindingEdgesSettings.
- The None-None type compatibility check can cause false validation errors for param-type pins
  (heuristics, blend ops, goal pickers) — these are safe to ignore; the UE validator has a guard.

## General
- Always check actual pin names via get_node_details before connecting nodes.
- Cluster nodes (Delaunay, Voronoi, etc.) output "Vtx" and "Edges" — not "Out".
`;

export function getGraphPatterns(): string {
  return GRAPH_PATTERNS;
}

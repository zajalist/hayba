---
name: hayba-world-partition-streaming
description: Use when diagnosing whether a World Partition area and its actors appear at the intended time during a player route.
metadata:
  category: world-composition
  tags: world-partition, streaming, actors, traversal
---

# Trace one streaming route

## When to use

Use for a bounded route with a missing actor, visible pop, or actor concentration. Record the camera path, expected actors, target platform, and any frame or memory budget. Decide what must be resident at each waypoint before calling the area correct.

## Tool routing

- Read wp_get_streaming_state to confirm the map uses World Partition. Use wp_get_cells only as a fixed-grid summary of loaded editor actors; its bins are not runtime World Partition cell identifiers. Use world_budget_snapshot and scene_export to identify actor classes and loaded concentrations, noting unknown unloaded coverage.
- Check editor_get_state, then start editor_start_pie if no user session is active. Traverse the agreed route and query editor_pie_actor_list at named waypoints; use editor_stream_log for load or missing-reference warnings. Always finish a session this workflow started with editor_stop_pie.
- Compare repeatable timings with editor_get_performance_stats if a budget was supplied. The exposed tools do not enumerate real World Partition runtime cell residency or prove why an absent actor failed to load; use Unreal's streaming visualization or logs manually for that diagnosis before changing partition configuration.

## Evidence

Report route waypoints, editor loaded-actor baseline, PIE actor presence and timing, log findings, budget measurements, and unknown runtime-cell coverage. Do not claim streaming correctness from wp_get_cells counts or a single actor-list snapshot.

---
name: hayba-pie-performance-capture
description: Use when collecting repeatable PIE timing and editor-memory proxy samples for one route before comparing a scene change.
metadata:
  category: optimization
  tags: pie, profiling, frame-time, memory
---

# Capture one repeatable PIE performance sample

## When to use

Use when a change needs before/after evidence under the same map, route, viewport, quality settings, and machine load. Record target platform and actual frame or memory budget; if missing, report a baseline without a pass verdict.

## Tool routing

- Take world_budget_snapshot for loaded structural counts and record its coverage. Check editor_get_state, start editor_start_pie, settle the scene, then call editor_pie_capture_start for a bounded sample. Poll editor_pie_capture_get by its capture identifier until complete or aborted. Stop with editor_stop_pie after the capture.
- Repeat the same route and sample count after one controlled change. Feed complete compatible snapshots and completed PIE captures to world_compare_snapshots. If scan coverage or captures differ, keep the observed values but withhold the delta verdict. Use editor_get_performance_stats as a separate editor metric, not as interchangeable frame time.
- Inspect warnings, truncated samples, world changes, and aborted captures before concluding anything. A safety refusal while the editor is unsafe is a stop signal, not permission to retry in a loop.

## Evidence

Report protocol, capture identifiers and status, sample counts, timing and physical-memory proxies, structural coverage, comparison result, and unknowns. These are whole-editor measurements: GPU time, real World Partition cells, NPC AI cost, packaged-build memory, and a production-performance verdict remain unmeasured.

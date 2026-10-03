---
name: hayba-niagara-vfx-pass
description: Use when placing or tuning one Niagara effect and checking system warnings, visibility, timing, and measured scene cost.
metadata:
  category: vfx
  tags: niagara, particles, placement, performance
---

# Place one Niagara effect

## When to use

Use for a specific gameplay signal or environmental effect with a target position, duration, scale, and readability requirement. Record the target platform, maximum simultaneous instances, and visual or frame budget if supplied.

## Tool routing

- Start with niagara_capability_probe and niagara_systems, then inspect the chosen asset through niagara_system_inspect and niagara_validate. Treat missing emitter or exposed-parameter reflection as an information gap, not a clean validation pass. Prefer an existing system over creating a new template asset for a placement task.
- Place a persistent level effect with niagara_place_actor; use niagara_spawn_transient only for a throwaway preview. Check asset-assigned and warning fields after placement. Use niagara_param_list before niagara_param_set on a live component, and require its applied flag before accepting the change.
- Re-inspect the component with niagara_component_inspect, capture the same view with editor_capture_viewport, and measure editor_get_performance_stats in the target scene. Use an actual PIE trigger for a gameplay effect whose timing matters; a still image cannot establish spawn or fade behavior.
- For an accepted persistent actor or component change, save the exact active map through level_save, inspect saved, dirty, and verified status, and re-inspect the component. A transient preview needs no map save. If persistence is uncertain, mark the placement unsaved and route it to hayba-world-save-integrity.

## Evidence

Report system and actor paths, validation violations, applied parameters, visible result, instance assumptions, and measured cost. If fixed bounds, effect type, or emitter reflection remains uncertain, carry that warning forward rather than calling the VFX production ready.

---
name: hayba-world-save-integrity
description: Use when checking that an authored level edit survives save and reload with expected actors, transforms, and validation state.
metadata:
  category: qa
  tags: level, persistence, reload, verification
---

# Verify a level save and reload

## When to use

Use after a bounded level edit on a scratch or otherwise authorized map, especially before handoff. Identify the exact map, changed actors, expected transforms or folders, and other editors or users who may have unsaved work. This tests authored level persistence, not a player's SaveGame.

## Tool routing

- Read level_get_info, actor_list, and world_semantic_snapshot for an identifiable baseline. Check editor_get_state and confirm no conflicting PIE or unsaved work outside the target. Save the current map with level_save using its exact-path guard, and inspect saved, dirty, and verified readback. A map-save result may not prove every external actor package was persisted.
- Reload the same map with level_load only after the save has completed and the current editor session can be replaced safely. Re-read level_get_info, actor_list, and the changed actors with actor_inspect; compare names, paths, transforms, and relationships. Run validator_run after reload.
- If a package is read-only or save verification is uncertain, stop before loading away the editor state. Resolve the package issue or preserve the current session for manual inspection rather than assuming it will survive.

## Evidence

Report map path, changed actor identities, before/after readbacks, save response, reload result, validator findings, and unresolved external actor coverage. Matching loaded actors do not prove unloaded World Partition cells or gameplay state persisted.

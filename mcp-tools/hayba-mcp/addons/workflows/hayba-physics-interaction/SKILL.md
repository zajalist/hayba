---
name: hayba-physics-interaction
description: Use when making one Unreal object pushable or blocking and checking collision, simulation, and observed interaction in PIE.
metadata:
  category: gameplay
  tags: physics, collision, interaction, pie
---

# Verify one physical interaction

## When to use

Use for one identified primitive component and one expected player action, such as pushing a crate or passing a trigger. Record the required collision response, mass or movement expectation, and the platform's object-count or physics budget if supplied.

## Tool routing

- Find the actor with actor_find and inspect its components through actor_get_components. Run scene_validate_physics to locate overlaps or penetration before changing the setup. Confirm the project collision profile name before physics_set_collision_profile; the tool reads the assigned profile back and rejects a mismatch.
- Use physics_set_simulate only on the intended primitive. Inspect its returned simulation flag: an accepted setter call can still read back false when the component cannot simulate. physics_add_impulse is an editor-world probe and refuses a non-simulating component; it cannot prove the player interaction in PIE.
- Re-run scene_validate_physics. For runtime behavior, check editor_get_state, start editor_start_pie, perform the intended input with editor_pie_press_key or editor_pie_click_actor as appropriate, inspect the PIE actor through editor_pie_actor_inspect, and stop with editor_stop_pie. Leave an existing user PIE session alone.
- For an accepted edit to a placed component, re-read its collision and simulation settings, save the exact active map with level_save, and inspect saved, dirty, and verified status. Re-read the component after saving; if persistence is uncertain, mark the setup unsaved and route it to hayba-world-save-integrity. An editor-world impulse is only a probe and is not a persistent edit.

## Evidence

Report actor and component identity, requested and read-back profile, simulation state, collision findings, PIE input and observed response, plus unresolved warnings. Editor-world velocity or a nonpenetrating placement does not prove the runtime control, networking, or player feel.

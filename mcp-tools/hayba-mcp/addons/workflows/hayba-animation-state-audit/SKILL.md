---
name: hayba-animation-state-audit
description: Use when reviewing or changing an Animation Blueprint state machine and checking transitions and compilation in Unreal.
metadata:
  category: animation
  tags: state-machine, transitions, blueprint, compile
---

# Audit an animation state machine

## When to use

Use when a character animation sticks, transitions unexpectedly, or needs one additional state. Identify the Animation Blueprint and a reproducible trigger before editing.

## Tool routing

- Read `anim_blueprint_get_info` and the signature of each intended mutation with `get_tool_signature`. Compare existing states and transitions to the desired behavior. A missing state and a wrong condition need different fixes.
- Use `anim_blueprint_add_state` only when a state is missing. Decide the transition rule before calling `anim_blueprint_add_transition`: a newly created edge has no rule and is always taken. Immediately pass its returned transition ID to `anim_blueprint_set_condition`, unless the intended edge is explicitly unconditional. If the required rule cannot be expressed, do not create the edge; if setting it fails after creation, surface the live unconditional edge for correction before testing. Compile with `anim_blueprint_compile`, inspect errors, and persist the intended asset with `asset_save`.
- Check `editor_get_state` before a runtime test. If this workflow starts `editor_start_pie`, exercise the trigger and always call `editor_stop_pie` afterward, including when observation fails. Leave a PIE session that was already running under the user's control. A successful compile establishes a valid asset, not that the runtime transition occurs at the right moment or produces a good blend.

## Evidence

Report the prior state/transition graph, the rule attached to any new edge, the exact change, save and compile result, PIE trigger, and observed transition. Limit a pass to one behavior fault so the cause of any regression remains clear.

---
name: hayba-cinematic-shot
description: Use when creating or refining a short Unreal Sequencer shot with actor binding, camera cuts, timing, and sequence validation.
metadata:
  category: cinematics
  tags: sequencer, camera, timing, shot
---

# Author one cinematic shot

## When to use

Use for a bounded sequence or shot with a purpose: reveal, transition, reaction, or establishing view. Define the target frame rate, duration, subject, and start/end composition before keyframing.

## Tool routing

- Use `seq_list` and `seq_inspect` before creating a duplicate. For a new asset, `seq_new` establishes the sequence, `seq_bind_actor` links the subject, `seq_camera_cut` chooses the camera, and `seq_playback_range` bounds the shot. Read exact signatures before mutations.
- Use `seq_validate` for missing bindings, tracks, or camera cuts. `editor_capture_viewport` gives still-frame composition evidence, while a timed playback must be viewed to judge motion and rhythm.
- Prefer adjusting an existing sequence when the requested shot already has usable bindings. Keep the first pass to one shot and one timing revision.

## Evidence

Report sequence path, bound actors, cut frames, range, validation result, and representative frames. Mark camera motion, continuity, and pacing as unverified until playback has actually been observed.

---
name: hayba-sequencer-motion-pass
description: Use when refining actor or camera movement inside an existing Sequencer shot and checking key timing, framing, and playback continuity.
metadata:
  category: cinematics
  tags: sequencer, motion, keyframes, continuity
---

# Refine motion in one sequence

## When to use

Use when a shot already exists but a bound actor or camera moves at the wrong speed, path, or moment. Record frame rate, playback range, start and end transforms, key times, screen composition, and any continuity constraint from adjacent shots.

## Tool routing

- Read seq_inspect and seq_list_bindings for the asset, its frame rate, binding identifiers, and current tracks. Use seq_track_add only when the necessary transform track is absent. Confirm the exact binding with get_tool_signature before seq_transform_keyframe; it keys possessed actor transforms at seconds converted to sequence ticks.
- Add a small number of keys, then re-inspect with seq_inspect and run seq_validate. Resolve empty tracks, out-of-range sections, or missing cuts before treating the shot as valid. Use editor_capture_viewport at named frames for framing evidence; open or play the sequence in Unreal to inspect acceleration and continuity.
- If audio or event timing must be changed, seq_track_add can create those track types, but this workflow has no typed command to author every section and payload. Make unsupported section edits in Sequencer and verify by playback.

## Evidence

Report sequence, binding, frame rate, key times and transforms, validation findings, representative frames, and playback observation. A valid sequence graph and still frames do not prove smooth motion, camera comfort, or correct inter-shot timing.

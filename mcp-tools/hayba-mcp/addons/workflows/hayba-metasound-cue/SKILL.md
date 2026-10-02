---
name: hayba-metasound-cue
description: Use when creating or repairing one interactive MetaSound cue and checking graph validity, audible behavior, and level-meter evidence.
metadata:
  category: audio
  tags: metasound, cue, graph, mix
---

# Author one MetaSound cue

## When to use

Use for a bounded event such as an impact, pickup, or interaction cue. Define trigger, expected duration, variation, mix target, and whether it must be spatial. Identify the source recordings and rights before graph work.

## Tool routing

- Search metasound_list and inspect an existing asset with metasound_inspect. Use metasound_create only if there is no suitable cue. Inspect the registered node and pin facts before metasound_add_node, metasound_connect, and metasound_set_input; do not infer pins from another engine version.
- Compile through metasound_compile and inspect validity, warnings, and saved state. A failed save after a valid conform can leave an applied but unsaved graph; re-inspect the exact asset before retrying. Use audio_asset_inspect to check sound asset settings.
- Audition through audio_play or a configured PIE trigger. For spectral output, use audio_meter_start, audio_meter_read, and audio_meter_stop around playback. Compare at a stated monitoring level and against the project's mix target; frequency-band magnitudes are not perceived loudness or proof of spatial behavior.

## Evidence

Report graph path, node and pin connections, compile warnings, save status, audible observation, and any measured spectral bins. If playback or the runtime trigger was unavailable, leave sound quality and integration unverified rather than treating compilation as an audio pass.

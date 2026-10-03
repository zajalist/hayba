---
name: hayba-audio-soundscape
description: Use when selecting and tuning ambient audio for an Unreal area, with active-sound and level-meter evidence in PIE.
metadata:
  category: audio
  tags: ambience, soundscape, spatial-audio, mix
---

# Build an area soundscape

## When to use

Use for a defined area or scene mood with a clear listening position. Note required accessibility alternatives and whether sounds are ambient loops, one-shots, or interactive cues.

## Tool routing

- Discover existing sounds with `audio_list` and inspect candidates through `audio_asset_inspect`. Prefer an existing suitable cue over making a new sound asset. Confirm any asset path before playback.
- Preview with `audio_play` or a placed component as appropriate. Check `editor_get_state` before using PIE. If this workflow starts `editor_start_pie`, stop only its own session with `editor_stop_pie` after measurement, including on failure. In PIE, use `audio_active_sounds` to check what is actually playing and `audio_meter_start` plus `audio_meter_read` for measured levels; always finish the meter session with `audio_meter_stop`. `audio_set_volume` can tune an identified source, but volume alone cannot solve masking from overlapping content.
- Keep sound selection and mix adjustment separate. If an asset or spatial behavior is unavailable, specify the missing source or routing without inventing playback evidence.
- If tuning changed a persistent placed source rather than only a playback preview, re-read that component, save the exact active map with `level_save`, and inspect saved, dirty, and verified status. Re-read the source after saving. If persistence is uncertain, mark the placement unsaved and route it to hayba-world-save-integrity.

## Evidence

Record sound assets, listener position, active voices, observed level readings, and the change made. Compare under the same playback conditions. Stop after one area and one balance revision before propagating the mix to other spaces.

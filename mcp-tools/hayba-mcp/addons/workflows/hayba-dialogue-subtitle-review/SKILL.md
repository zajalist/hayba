---
name: hayba-dialogue-subtitle-review
description: Use when checking one voiced dialogue beat for subtitle timing, legibility, safe layout, and audible playback.
metadata:
  category: narrative
  tags: dialogue, subtitles, timing, audio
---

# Review one voiced dialogue beat

## When to use

Use for a specific line or exchange with known voice asset, speaker, language, and intended duration. Record the subtitle text, reading-speed target, viewport sizes, and the moment the line should begin and end. Project dialogue and localization systems vary; identify the actual owner before editing.

## Tool routing

- Inspect the sound with audio_asset_inspect and the subtitle widget with ui_get_widget_info. Measure the actual and longest expected line with ui_measure_text, then use ui_layout_snapshot, ui_render_widget_to_png, and ui_validate for clipping, safe areas, and contrast. Fix a confirmed layout problem with ui_set_slot_layout or ui_set_text_style, then re-render and revalidate.
- Check editor_get_state, start editor_start_pie only when a dialogue trigger exists, and observe live text with editor_pie_widget_tree and sound presence with audio_active_sounds. Capture the start, middle, and end through editor_pie_screenshot, polling each requested file. Stop with editor_stop_pie after this workflow's session.
- If the project has no typed dialogue or subtitle timing authoring path, make that edit in its own Unreal system and use this workflow for verification. Do not use 2D audio preview to claim spatial dialogue placement.

## Evidence

Report text, language, voice asset, observed display interval, measured layout, validation findings, sound presence, and any timing mismatch. Active-sound presence does not prove lip sync, audibility, or exact subtitle synchronization; these need listened and viewed playback.

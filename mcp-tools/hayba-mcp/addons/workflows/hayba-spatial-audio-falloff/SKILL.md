---
name: hayba-spatial-audio-falloff
description: Use when a world sound is too loud, too quiet, or persists at the wrong listener distance and attenuation needs verification.
metadata:
  category: audio
  tags: attenuation, distance, spatial-audio, mix
---

# Check one spatial sound's falloff

## When to use

Use for one level-owned sound with a known listener route and desired near, mid, and far behavior. Record expected audible radius, priority relative to other sounds, max concurrent voices, and target platform or mix constraints. Do not use a 2D preview to judge spatial falloff.

## Tool routing

- Inspect the sound and its SoundAttenuation or SoundConcurrency asset with audio_asset_inspect. Read audio_active_sounds during the relevant scene to identify the live owner, effective volume, and virtualization or voice use. If the expected attenuation asset is missing, use audio_asset_create for that supported settings class.
- Change one typed setting with audio_asset_set, inspect changed and unchanged keys plus complete readback, then persist through audio_asset_save. A setter call does not save implicitly. Re-inspect the same asset after saving.
- Check editor_get_state, start editor_start_pie, move the listener through the named positions, and sample audio_active_sounds at each point. Listen at a controlled monitoring level and record whether the sound enters, fades, and exits as intended. Stop with editor_stop_pie. If the project does not attach the attenuation asset to the emitter, complete that binding in its actor or sound setup and verify it there.

## Evidence

Report asset and emitter identities, attenuation settings, near/mid/far active-sound facts, voice use, listening observation, and unresolved warnings. Effective volume or a spectral meter alone does not prove perceived loudness, directionality, or behavior on a different speaker setup.

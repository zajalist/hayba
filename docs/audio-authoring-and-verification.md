# Audio authoring and verification

Hayba's audio domain has three separate concerns: persistent asset authoring,
live component control, and output verification. Keeping those boundaries
explicit prevents a successful editor mutation from being confused with a
saved asset or an audible result.

## Persistent audio assets

The supported settings assets are `SoundClass`, `SoundMix`,
`SoundConcurrency`, `SoundAttenuation`, and `SoundSubmix`. `SoundWave` settings
can be inspected and changed, but a wave cannot be created empty: import PCM
audio with `asset_import`, then use the audio tools.

Use this lifecycle:

1. `audio_asset_create` creates a new settings asset in memory and returns its
   canonical path plus the engine defaults. It does not save.
2. `audio_asset_set` changes typed settings and returns `changed_keys`,
   `unchanged_keys`, and complete typed readback. Incompatible keys are rejected
   against the target's actual class. It does not save.
3. `audio_asset_inspect` is the read entry point before and after edits.
4. `audio_asset_save` is the only persistence boundary. It saves one target and
   verifies that the package file exists on disk.

All asset-path parameters share the same normalization. These are equivalent:

```text
/Game/Audio/Classes/SC_UI
/Game/Audio/Classes/SC_UI.SC_UI
SoundClass'/Game/Audio/Classes/SC_UI.SC_UI'
```

Creation targets must be under `/Game` and must include an asset name.

`SoundMix.class_overrides` is a complete replacement array, not an append. Each
entry names a SoundClass and its volume, pitch, low-pass cutoff, child-policy,
and center-channel gain. Every reference is resolved before the target mix is
changed. The same replacement rule applies to `SoundSubmix.effect_chain` and
`SoundWave.concurrency`.

## Retained runtime components

`audio_component_play` starts 2D playback with auto-destroy disabled. It
returns a string `component_id` only after the new component reports an active
play state. Use `audio_component_control` with that id to:

- play, stop, pause, or resume;
- fade in or out;
- set component volume or pitch;
- set float, integer, Boolean, trigger, or SoundWave parameters for SoundCue or
  MetaSound state; or
- reset all parameters.

Expired ids and a `play`/`fade_in` operation that does not become active are
errors. `audio_active_sounds` reads the engine's active sounds and physical
voice count, including effective gain, pitch, looping, pause, audible versus
virtual state, owner, and component id. That is the verification command for
concurrency and voice-budget work.

The older `audio_play` command now also creates a retained component and returns
its id and play-state readback. New integrations should use
`audio_component_play` because its first-class schema is more specific.

## Spectrum metering

Spectrum analysis is an explicit lifecycle:

1. `audio_meter_start` targets the master output (omit `submix_path`) or one
   SoundSubmix and selects an FFT size.
2. After at least one audio render block, `audio_meter_read` samples 1–256
   frequencies. Each bin returns linear magnitude, dB magnitude, and phase.
3. `audio_meter_stop` releases that analyzer.

Hayba tracks analyzer state per target. Reading before start, starting twice,
or stopping a target that is not active fails. If the Audio Mixer produces no
bins, the read is an error rather than a zero-filled success response.

## WAV capture

`audio_recording_start` begins master/submix Audio Mixer capture with an
expected duration used to size the buffer. `audio_recording_stop` consumes that
buffer and writes it synchronously with UE's public PCM writer.

Capture output is restricted to `Saved/BouncedWavFiles`. `relative_path` may
select a subfolder, but absolute paths and `..` are rejected. Success returns
the verified absolute WAV path, sample count, channel count, sample rate, and
duration. Zero samples, writer failure, and an absent output file are all outer
command errors.

Spectrum analysis and recording require an Audio Mixer device. Hayba checks
that capability before starting and reports the engine limit explicitly when
the active project/device does not provide it.

## Safety and retry behavior

Every audio mutation is Plan-Mode gated, including retry-safe set/save calls.
Operations that can duplicate a voice, re-trigger a component, or consume a
recording buffer are also classified non-idempotent and are never retried after
a transport failure. Asset setting and saving remain retry-safe set-to-value
operations.

import { z } from 'zod';
import type { ToolDescriptor } from '../register-tool.js';
import { ueTool } from '../ue-tool.js';

const assetPath = z
  .string()
  .min(1)
  .describe(
    'UE content asset path. Package-only (/Game/Audio/SC_UI), object (/Game/Audio/SC_UI.SC_UI), and UE export-text paths are normalized identically.',
  );

const nullableAssetPath = assetPath.nullable().describe('Asset path, or null to clear the reference.');

const classOverride = z
  .object({
    sound_class_path: assetPath.describe('SoundClass affected by this override.'),
    volume: z.number().min(0).default(1).describe('Volume multiplier.'),
    pitch: z.number().min(0).max(8).default(1).describe('Pitch multiplier.'),
    low_pass_filter_frequency: z.number().min(0).max(20_000).default(20_000).describe('Low-pass cutoff in Hz.'),
    apply_to_children: z.boolean().default(false).describe('Apply the override to descendant SoundClasses.'),
    voice_center_channel_volume: z.number().min(0).default(1).describe('Center-channel volume multiplier.'),
  })
  .strict();

/** One discoverable settings vocabulary spanning the six supported asset
 * types. UE validates applicability against the target's actual class and
 * rejects the whole call before mutation when a key belongs to another type. */
export const audioAssetSettingsSchema = z
  .object({
    // SoundClass
    parent_sound_class: nullableAssetPath
      .optional()
      .describe('SoundClass only: serialized parent; both parent child-lists are updated.'),
    default_submix: nullableAssetPath.optional().describe('SoundClass only: default output SoundSubmix.'),
    always_play: z.boolean().optional().describe('SoundClass only: raise playback priority.'),
    is_ui_sound: z.boolean().optional().describe('SoundClass only: play while paused as UI audio.'),
    is_music: z.boolean().optional().describe('SoundClass only: mark the class as music.'),
    apply_ambient_volumes: z
      .boolean()
      .optional()
      .describe('SoundClass only: apply interior/exterior ambient-volume modifiers.'),
    reverb: z.boolean().optional().describe('SoundClass only: send to master reverb.'),
    default_2d_reverb_send_amount: z
      .number()
      .min(0)
      .optional()
      .describe('SoundClass only: master reverb send for unattenuated 2D sounds.'),
    attenuation_distance_scale: z
      .number()
      .positive()
      .optional()
      .describe('SoundClass only: scale perceived attenuation distance.'),
    low_pass_filter_frequency: z
      .number()
      .min(0)
      .max(20_000)
      .optional()
      .describe('SoundClass or SoundMix override: low-pass cutoff in Hz.'),

    // Shared on SoundClass and SoundWave; the target class determines the field.
    volume: z.number().min(0).optional().describe('SoundClass or SoundWave: linear playback volume multiplier.'),
    pitch: z.number().min(0.125).max(8).optional().describe('SoundClass or SoundWave: pitch multiplier.'),

    // SoundMix
    initial_delay: z.number().min(0).optional().describe('SoundMix only: delay before applying.'),
    fade_in_time: z.number().min(0).optional().describe('SoundMix only: fade-in seconds.'),
    duration: z.number().optional().describe('SoundMix only: active seconds; negative means indefinite.'),
    fade_out_time: z.number().min(0).optional().describe('SoundMix only: fade-out seconds.'),
    apply_eq: z.boolean().optional().describe('SoundMix only: enable its EQ settings.'),
    eq_priority: z.number().optional().describe('SoundMix only: EQ priority.'),
    class_overrides: z
      .array(classOverride)
      .optional()
      .describe(
        'SoundMix only: complete replacement array of per-SoundClass volume/pitch/LPF overrides. Every referenced class is preflighted before mutation.',
      ),

    // SoundConcurrency
    max_count: z.number().int().min(1).optional().describe('SoundConcurrency only: maximum active voices.'),
    limit_to_owner: z.boolean().optional().describe('SoundConcurrency only: scope concurrency to the owning actor.'),
    resolution_rule: z
      .enum([
        'PreventNew',
        'StopOldest',
        'StopFarthestThenPreventNew',
        'StopFarthestThenOldest',
        'StopLowestPriority',
        'StopQuietest',
      ])
      .optional()
      .describe('SoundConcurrency only: eviction/rejection rule.'),
    retrigger_time: z
      .number()
      .min(0)
      .optional()
      .describe('SoundConcurrency only: minimum seconds between accepted plays.'),
    volume_scale: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('SoundConcurrency only: compounded ducking scale for older generations.'),
    volume_scale_mode: z
      .enum(['Default', 'Distance', 'Priority'])
      .optional()
      .describe('SoundConcurrency only: ordering used for volume scaling.'),
    volume_scale_attack_time: z.number().min(0).optional().describe('SoundConcurrency only: duck attack seconds.'),
    volume_scale_release_time: z.number().min(0).optional().describe('SoundConcurrency only: duck recovery seconds.'),
    voice_steal_release_time: z.number().min(0).optional().describe('SoundConcurrency only: eviction fade seconds.'),
    volume_scale_can_release: z
      .boolean()
      .optional()
      .describe('SoundConcurrency only: allow older voices to recover as peers stop.'),

    // SoundAttenuation
    attenuate: z.boolean().optional().describe('SoundAttenuation only: enable distance-volume attenuation.'),
    spatialize: z.boolean().optional().describe('SoundAttenuation only: enable 3D spatialization.'),
    distance_model: z
      .enum(['Linear', 'Logarithmic', 'Inverse', 'LogReverse', 'NaturalSound', 'Custom'])
      .optional()
      .describe('SoundAttenuation only: distance response model.'),
    attenuation_shape: z
      .enum(['Sphere', 'Capsule', 'Box', 'Cone'])
      .optional()
      .describe('SoundAttenuation only: geometric falloff shape.'),
    shape_extents: z
      .object({
        x: z.number().min(0),
        y: z.number().min(0).default(0),
        z: z.number().min(0).default(0),
      })
      .strict()
      .optional()
      .describe('SoundAttenuation only: shape dimensions; interpretation depends on attenuation_shape.'),
    falloff_distance: z
      .number()
      .min(0)
      .optional()
      .describe('SoundAttenuation only: distance over which volume falls off.'),
    air_absorption: z.boolean().optional().describe('SoundAttenuation only: enable distance LPF.'),
    listener_focus: z.boolean().optional().describe('SoundAttenuation only: enable listener-focus adjustments.'),
    occlusion: z.boolean().optional().describe('SoundAttenuation only: enable realtime occlusion traces.'),
    complex_occlusion: z.boolean().optional().describe('SoundAttenuation only: trace complex collision for occlusion.'),
    reverb_send: z.boolean().optional().describe('SoundAttenuation only: enable distance-based reverb sends.'),

    // SoundSubmix
    parent_submix: nullableAssetPath
      .optional()
      .describe('SoundSubmix only: serialized parent; UE updates old/new child lists.'),
    auto_disable: z.boolean().optional().describe('SoundSubmix only: disable after silence to save CPU.'),
    auto_disable_time: z.number().min(0).optional().describe('SoundSubmix only: silence time before auto-disable.'),
    mute_when_backgrounded: z.boolean().optional().describe('SoundSubmix only: mute when the app is backgrounded.'),
    envelope_attack_ms: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('SoundSubmix only: envelope follower attack milliseconds.'),
    envelope_release_ms: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('SoundSubmix only: envelope follower release milliseconds.'),
    effect_chain: z
      .array(assetPath)
      .optional()
      .describe('SoundSubmix only: complete replacement array of SoundEffectSubmixPreset assets.'),

    // SoundWave import/playback policy
    compression_quality: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('SoundWave only: platform-agnostic compression quality.'),
    compression_type: z
      .enum(['PlatformSpecific', 'PCM', 'ADPCM', 'BinkAudio', 'Opus', 'RADAudio'])
      .optional()
      .describe('SoundWave only: codec policy.'),
    sample_rate_quality: z
      .enum(['Max', 'High', 'Medium', 'Low', 'Min'])
      .optional()
      .describe('SoundWave only: platform sample-rate tier.'),
    loading_behavior: z
      .enum(['Inherited', 'RetainOnLoad', 'PrimeOnLoad', 'LoadOnDemand', 'ForceInline', 'Uninitialized'])
      .optional()
      .describe('SoundWave only: stream-cache loading behavior override.'),
    looping: z.boolean().optional().describe('SoundWave only: loop when played directly.'),
    sound_class: nullableAssetPath.optional().describe('SoundWave only: SoundClass routing asset.'),
    attenuation: nullableAssetPath.optional().describe('SoundWave only: SoundAttenuation settings asset.'),
    base_submix: nullableAssetPath.optional().describe('SoundWave only: base output SoundSubmix.'),
    concurrency: z
      .array(assetPath)
      .optional()
      .describe('SoundWave only: complete replacement set of SoundConcurrency assets.'),
  })
  .strict();

const audioComponentControlSchema = z
  .object({
    component_id: z.string().min(1).describe('Stable string id returned by audio_component_play or audio_play.'),
    action: z
      .enum([
        'play',
        'stop',
        'pause',
        'resume',
        'fade_in',
        'fade_out',
        'set_volume',
        'set_pitch',
        'set_parameter',
        'reset_parameters',
      ])
      .describe('Control operation.'),
    duration: z.number().min(0).default(0).describe('Fade seconds for fade_in/fade_out.'),
    level: z.number().min(0).default(1).describe('Target gain for fades/set_volume, or multiplier for set_pitch.'),
    start_time: z.number().min(0).default(0).describe('Playback seek offset for play/fade_in.'),
    parameter_name: z.string().min(1).optional().describe('Required for set_parameter.'),
    parameter_type: z
      .enum(['float', 'int', 'bool', 'wave', 'trigger'])
      .optional()
      .describe('Required for set_parameter.'),
    parameter_value: z
      .union([z.number(), z.boolean(), z.string()])
      .optional()
      .describe('Typed value; wave takes a SoundWave path, trigger needs no value.'),
  })
  .strict();

const submixTarget = {
  submix_path: assetPath.optional().describe('SoundSubmix to target; omit for the master output.'),
};

const descriptors: ToolDescriptor[] = [
  {
    name: 'audio_asset_create',
    description:
      'Create an unsaved SoundClass, SoundMix, SoundConcurrency, SoundAttenuation, or SoundSubmix asset at an explicit /Game path. Returns the canonical path and full default readback; call audio_asset_set, then audio_asset_save as the persistence boundary.',
    schema: {
      path: assetPath.describe('Full target asset path including its asset name.'),
      asset_type: z
        .enum(['SoundClass', 'SoundMix', 'SoundConcurrency', 'SoundAttenuation', 'SoundSubmix'])
        .describe(
          'Audio settings asset class. SoundWave creation is intentionally excluded because it requires imported PCM data.',
        ),
    },
    meta: {
      cost: 'medium',
      effects: ['creates_asset'],
      when: 'creating an authorable audio routing, mix, concurrency, attenuation, or submix asset',
      not_when: 'importing a SoundWave (use asset_import), or when the target path already exists',
    },
    handler: ueTool(
      'audio_asset_create',
      z
        .object({
          path: assetPath,
          asset_type: z.enum(['SoundClass', 'SoundMix', 'SoundConcurrency', 'SoundAttenuation', 'SoundSubmix']),
        })
        .strict(),
    ),
    cost: 'medium',
    returns: '{path, asset_type, persistence:"dirty_in_memory", readback:{path,asset_type,dirty,settings}}',
  },
  {
    name: 'audio_asset_inspect',
    description:
      'Inspect one SoundClass, SoundMix (including class overrides), SoundConcurrency, SoundAttenuation, SoundSubmix, or SoundWave using a stable typed settings vocabulary.',
    schema: { path: assetPath },
    meta: {
      cost: 'low',
      effects: [],
      when: 'reading exact audio asset settings before or after an edit',
      not_when: 'enumerating sounds by folder (use audio_list) or inspecting live voices (use audio_active_sounds)',
    },
    handler: ueTool('audio_asset_inspect', z.object({ path: assetPath }).strict()),
    cost: 'low',
    returns: '{path, asset_type, dirty, settings}',
  },
  {
    name: 'audio_asset_set',
    description:
      'Set typed audio asset settings in memory with changed/unchanged key diagnostics and complete typed readback. The actual target class controls which documented keys are legal; incompatible or unknown keys fail before mutation. This command never saves implicitly.',
    schema: { path: assetPath, settings: audioAssetSettingsSchema },
    meta: {
      cost: 'medium',
      effects: ['modifies_asset'],
      when: 'authoring routing, mix overrides, voice limits, spatial falloff, submix topology/effects, or SoundWave playback/import policy',
      not_when: 'persisting an already-authored asset (use audio_asset_save) or controlling a live component',
    },
    handler: ueTool('audio_asset_set', z.object({ path: assetPath, settings: audioAssetSettingsSchema }).strict()),
    cost: 'medium',
    returns: '{path, asset_type, changed_keys, unchanged_keys, persistence, readback}',
  },
  {
    name: 'audio_asset_save',
    description:
      'Explicitly save one supported audio settings asset and verify its .uasset exists on disk. Single-target by design so a failure cannot hide partial batch persistence.',
    schema: { path: assetPath },
    meta: {
      cost: 'medium',
      effects: ['modifies_asset', 'filesystem_write'],
      when: 'persisting an audio asset after create/set readback is correct',
      not_when: 'editing settings or saving unrelated asset classes',
    },
    handler: ueTool('audio_asset_save', z.object({ path: assetPath }).strict()),
    cost: 'medium',
    returns: '{path, package_file, persistence:"saved_to_disk", readback}',
  },
  {
    name: 'audio_component_play',
    description:
      'Play a 2D USoundBase through a retained, non-auto-destroy AudioComponent and return a stable component id plus live play-state readback. Fails if the component never becomes active.',
    schema: {
      path: assetPath.describe('USoundBase path: SoundWave, SoundCue, or MetaSoundSource.'),
      volume: z.number().min(0).default(1),
      pitch: z.number().positive().default(1),
      start_time: z.number().min(0).default(0),
      concurrency_path: assetPath.optional().describe('Optional SoundConcurrency override.'),
    },
    meta: {
      cost: 'low',
      effects: ['changes_audio_runtime'],
      when: 'starting controllable 2D music, ambience, UI, or audition playback',
      not_when: 'fire-and-forget audition with no later control, or spatial actor-attached audio',
    },
    handler: ueTool(
      'audio_component_play',
      z
        .object({
          path: assetPath,
          volume: z.number().min(0).default(1),
          pitch: z.number().positive().default(1),
          start_time: z.number().min(0).default(0),
          concurrency_path: assetPath.optional(),
        })
        .strict(),
    ),
    cost: 'low',
    returns: '{component_id, sound_path, world, play_state, volume, pitch}',
  },
  {
    name: 'audio_component_control',
    description:
      'Control a retained AudioComponent: play/stop/pause/resume, fade, set gain/pitch, reset parameters, or set typed MetaSound/SoundCue parameters. Returns live component readback; expired ids fail cleanly.',
    schema: audioComponentControlSchema.shape,
    meta: {
      cost: 'low',
      effects: ['changes_audio_runtime'],
      when: 'driving adaptive audio state transitions on a component returned by audio_component_play',
      not_when: 'changing imported SoundWave defaults or inspecting all active engine sounds',
    },
    handler: ueTool('audio_component_control', audioComponentControlSchema),
    cost: 'low',
    returns: '{component_id, action_applied, play_state, volume, pitch, virtualized}',
  },
  {
    name: 'audio_active_sounds',
    description:
      'Inspect live active sounds and physical voice usage from the main audio device, including component ids, asset paths, effective volume/pitch, looping, pause, virtualization/audibility, owner, and managed-component count.',
    schema: { include_preview: z.boolean().default(false), limit: z.number().int().min(1).max(2048).default(256) },
    meta: {
      cost: 'low',
      effects: [],
      when: 'debugging voice budgets, concurrency, leaked loops, virtualization, or verifying runtime playback',
      not_when: 'reading asset defaults or measuring output levels/frequencies',
    },
    handler: ueTool(
      'audio_active_sounds',
      z
        .object({ include_preview: z.boolean().default(false), limit: z.number().int().min(1).max(2048).default(256) })
        .strict(),
    ),
    cost: 'low',
    returns:
      '{active_sound_count, active_voice_count, virtual_sound_count, managed_component_count, truncated, sounds:[...]}',
  },
  {
    name: 'audio_meter_start',
    description:
      'Start Audio Mixer FFT analysis on the master output or one SoundSubmix. Explicit lifecycle: start once, read one or more times, then stop.',
    schema: {
      ...submixTarget,
      fft_size: z.enum(['min', 'small', 'medium', 'large', 'very_large', 'max']).default('medium'),
    },
    meta: {
      cost: 'low',
      effects: ['changes_audio_runtime'],
      when: 'beginning spectral output verification for a live audio mix',
      not_when: 'reading without an active analyzer, or when the project is not using the Audio Mixer',
    },
    handler: ueTool(
      'audio_meter_start',
      z
        .object({
          ...submixTarget,
          fft_size: z.enum(['min', 'small', 'medium', 'large', 'very_large', 'max']).default('medium'),
        })
        .strict(),
    ),
    cost: 'low',
    returns: '{submix, fft_size, analyzer_state:"started"}',
  },
  {
    name: 'audio_meter_read',
    description:
      'Read linear magnitude, dB magnitude, and phase at explicit frequencies from a previously started master/submix analyzer. Empty or unavailable spectral data is an error, never a zero-filled success claim.',
    schema: { ...submixTarget, frequencies_hz: z.array(z.number().positive().max(24_000)).min(1).max(256) },
    meta: {
      cost: 'low',
      effects: [],
      when: 'measuring actual frequency-band output after audio_meter_start',
      not_when: 'estimating loudness from asset volume fields or before an audio render block has elapsed',
    },
    handler: ueTool(
      'audio_meter_read',
      z
        .object({ ...submixTarget, frequencies_hz: z.array(z.number().positive().max(24_000)).min(1).max(256) })
        .strict(),
    ),
    cost: 'low',
    returns: '{submix, analyzer_state:"running", bins:[{frequency_hz,magnitude_linear,magnitude_db,phase_radians}]}',
  },
  {
    name: 'audio_meter_stop',
    description: 'Stop a master/submix FFT analyzer that Hayba started. Fails if that target has no tracked analyzer.',
    schema: submixTarget,
    meta: {
      cost: 'low',
      effects: ['changes_audio_runtime'],
      when: 'ending a spectral verification session',
      not_when: 'stopping playback or an output recording',
    },
    handler: ueTool('audio_meter_stop', z.object(submixTarget).strict()),
    cost: 'low',
    returns: '{submix, analyzer_state:"stopped"}',
  },
  {
    name: 'audio_recording_start',
    description:
      'Start in-memory Audio Mixer capture of the master output or one SoundSubmix. The matching stop command performs a synchronous, filesystem-verified WAV write.',
    schema: { ...submixTarget, expected_duration: z.number().positive().max(3600).default(10) },
    meta: {
      cost: 'low',
      effects: ['changes_audio_runtime'],
      when: 'capturing a bounded section of the live mix for objective review or tests',
      not_when: 'the active device is not Audio Mixer, or another capture is active for the same target',
    },
    handler: ueTool(
      'audio_recording_start',
      z.object({ ...submixTarget, expected_duration: z.number().positive().max(3600).default(10) }).strict(),
    ),
    cost: 'low',
    returns: '{submix, expected_duration, recording_state:"started"}',
  },
  {
    name: 'audio_recording_stop',
    description:
      'Stop a tracked master/submix capture and synchronously write a WAV beneath Saved/BouncedWavFiles. Returns the verified absolute path, sample count, channel count, sample rate, and duration; zero samples or an absent file is an error.',
    schema: {
      ...submixTarget,
      filename: z.string().min(1).describe('WAV basename; any supplied extension/directories are stripped.'),
      relative_path: z
        .string()
        .default('')
        .describe('Optional subfolder beneath Saved/BouncedWavFiles. Absolute paths and .. are rejected.'),
    },
    meta: {
      cost: 'medium',
      effects: ['changes_audio_runtime', 'filesystem_write'],
      when: 'finishing and proving a capture started by audio_recording_start',
      not_when: 'exporting outside the project Saved tree or when no tracked recording is active',
    },
    handler: ueTool(
      'audio_recording_stop',
      z.object({ ...submixTarget, filename: z.string().min(1), relative_path: z.string().default('') }).strict(),
    ),
    cost: 'medium',
    returns:
      '{submix, recording_state:"stopped", wav_path, sample_count, channel_count, sample_rate, duration_seconds}',
  },
];

export const AUDIO_DESCRIPTORS: ReadonlyArray<ToolDescriptor> = descriptors;

export const AUDIO_MUTATING_COMMANDS = [
  'audio_asset_create',
  'audio_asset_set',
  'audio_asset_save',
  'audio_component_play',
  'audio_component_control',
  'audio_meter_start',
  'audio_meter_stop',
  'audio_recording_start',
  'audio_recording_stop',
] as const;

export const AUDIO_NON_IDEMPOTENT_COMMANDS = [
  'audio_asset_create',
  'audio_component_play',
  'audio_component_control',
  'audio_recording_start',
  'audio_recording_stop',
] as const;

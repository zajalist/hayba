import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AUDIO_DESCRIPTORS,
  AUDIO_MUTATING_COMMANDS,
  AUDIO_NON_IDEMPOTENT_COMMANDS,
  audioAssetSettingsSchema,
} from './audio-tools.js';
import { NON_IDEMPOTENT } from '../tool-executor.js';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..', '..');
const audioHandler = readFileSync(
  join(
    repo,
    'unreal',
    'HaybaMCPToolkit',
    'Source',
    'HaybaMCPToolkit',
    'Private',
    'handlers',
    'HaybaMCPAudioHandler.cpp',
  ),
  'utf8',
);
const commandHandler = readFileSync(
  join(repo, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'HaybaMCPCommandHandler.cpp'),
  'utf8',
);
const sidecar = JSON.parse(
  readFileSync(join(repo, 'mcp-tools', 'hayba-mcp', 'src', 'legacy-commands', 'sidecar.json'), 'utf8'),
) as { commands: Record<string, { has_ts_wrapper: boolean; agent_callable: boolean }> };

const names = AUDIO_DESCRIPTORS.map((d) => d.name);

describe('audio command seam contract', () => {
  it('registers every descriptor in the UE handler and sidecar', () => {
    for (const name of names) {
      expect(audioHandler, name).toContain(`TEXT("${name}")`);
      expect(sidecar.commands[name], name).toMatchObject({ has_ts_wrapper: true, agent_callable: true });
    }
  });

  it('contains no bookkeeping-only ok:true success claims', () => {
    expect(audioHandler).not.toMatch(/SetBoolField\(TEXT\("ok"\),\s*true\)/);
    expect(audioHandler).not.toMatch(/SetBoolField\(TEXT\("saved"\),/);
  });

  it('fails closed when the mixer returns synthetic zero or non-finite spectral bins', () => {
    expect(audioHandler).toContain('analyzer returned only zero bins');
    expect(audioHandler).toContain('Audio Mixer returned invalid spectral magnitudes');
    expect(audioHandler).toContain('Audio Mixer returned invalid spectral phases');
  });

  it('keeps create/set separate from the verified save boundary', () => {
    const beforeSave = audioHandler.slice(
      audioHandler.indexOf('FHaybaHandlerResult AudioAssetCreate'),
      audioHandler.indexOf('FHaybaHandlerResult AudioAssetSave'),
    );
    expect(beforeSave).not.toContain('SaveLoadedAsset');
    const saveBody = audioHandler.slice(
      audioHandler.indexOf('FHaybaHandlerResult AudioAssetSave'),
      audioHandler.indexOf('FHaybaHandlerResult AudioList'),
    );
    expect(saveBody).toContain('SaveLoadedAsset');
    expect(saveBody).toContain('FileExists');
  });

  it('plan-gates every audio mutation, including retry-safe set/save operations', () => {
    for (const name of AUDIO_MUTATING_COMMANDS) {
      expect(commandHandler, name).toContain(`TEXT("${name}")`);
    }
  });

  it('classifies only duplicate-unsafe audio operations as NON_IDEMPOTENT', () => {
    for (const name of AUDIO_NON_IDEMPOTENT_COMMANDS) expect(NON_IDEMPOTENT.has(name), name).toBe(true);
    expect(NON_IDEMPOTENT.has('audio_asset_set')).toBe(false);
    expect(NON_IDEMPOTENT.has('audio_asset_save')).toBe(false);
    expect(NON_IDEMPOTENT.has('audio_meter_read')).toBe(false);
  });
});

describe('audio schemas are specific and fail closed', () => {
  it('documents and accepts a production SoundMix override payload', () => {
    expect(
      audioAssetSettingsSchema.parse({
        fade_in_time: 0.25,
        duration: -1,
        class_overrides: [
          {
            sound_class_path: '/Game/Audio/Classes/SC_City',
            volume: 0.7,
            pitch: 1,
            low_pass_filter_frequency: 12_000,
            apply_to_children: true,
            voice_center_channel_volume: 1,
          },
        ],
      }),
    ).toMatchObject({ fade_in_time: 0.25, duration: -1 });
  });

  it('rejects unknown, invalid-range, and misspelled settings before dispatch', () => {
    expect(audioAssetSettingsSchema.safeParse({ volumn: 0.5 }).success).toBe(false);
    expect(audioAssetSettingsSchema.safeParse({ compression_quality: 0 }).success).toBe(false);
    expect(audioAssetSettingsSchema.safeParse({ distance_model: 'AI_GuessedCurve' }).success).toBe(false);
  });

  it('publishes a real strict Zod shape for every first-class command', () => {
    for (const descriptor of AUDIO_DESCRIPTORS) {
      expect(Object.keys(descriptor.schema).length, descriptor.name).toBeGreaterThan(0);
      const schema = z.object(descriptor.schema).strict();
      expect(schema.safeParse({ definitely_not_a_parameter: true }).success, descriptor.name).toBe(false);
    }
  });
});

describe('audio wrappers route exact wire commands', () => {
  let ue: ScriptedUe | undefined;
  afterEach(() => ue?.restore());

  it('passes a typed asset mutation unchanged and returns UE readback', async () => {
    ue = scriptedUe().replies('audio_asset_set', (params) => ({
      path: params.path as string,
      changed_keys: ['fade_in_time'],
      unchanged_keys: [],
      persistence: 'dirty_in_memory',
      readback: params.settings as Record<string, unknown>,
    }));
    const descriptor = AUDIO_DESCRIPTORS.find((d) => d.name === 'audio_asset_set')!;
    const result = await descriptor.handler(
      {
        path: '/Game/Audio/MX_City',
        settings: { fade_in_time: 0.25 },
      },
      {} as never,
    );
    expect(ue.paramsFor('audio_asset_set')).toEqual({
      path: '/Game/Audio/MX_City',
      settings: { fade_in_time: 0.25 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('dirty_in_memory');
  });

  it('does not dispatch invalid nested settings', async () => {
    ue = scriptedUe().silentlySucceeds('audio_asset_set');
    const descriptor = AUDIO_DESCRIPTORS.find((d) => d.name === 'audio_asset_set')!;
    const result = await descriptor.handler(
      {
        path: '/Game/Audio/MX_City',
        settings: { compression_quality: 101 },
      },
      {} as never,
    );
    expect(result.isError).toBe(true);
    expect(ue.called('audio_asset_set')).toBe(false);
  });
});

/**
 * Horror's audio proof, 2026-11-09: an editor without focus sets FApp::SetVolumeMultiplier(0) every tick unless
 * ULevelEditorMiscSettings::bAllowBackgroundAudio is set (UEditorEngine::Tick), and editor Python reaches neither
 * switch, so every PIE recording on an agent's editor was digital silence that looked like a working take. This pins
 * the switch, the per-world recording, and the level in the stop reply.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { setDefaultSender, type Sender } from '../tool-executor.js';
import { AUDIO_DESCRIPTORS } from './audio-tools.js';

const handlers = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit',
  'Source', 'HaybaMCPToolkit', 'Private', 'handlers');
const read = (f: string) => readFileSync(join(handlers, f), 'utf8').replace(/\r\n/g, '\n');
const audio = read('HaybaMCPAudioHandler.cpp');
const between = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

describe('editor_set_background_audio', () => {
  it('flips the editor setting and the unfocused multiplier, and reports what they were', () => {
    const body = between(audio, 'FHaybaHandlerResult SetBackgroundAudio(', 'FHaybaHandlerResult AudioSetVolume(');
    expect(audio).toContain('TEXT("editor_set_background_audio")');
    expect(body).toContain('Settings->bAllowBackgroundAudio = bEnabled;');
    expect(body).toContain('FApp::SetUnfocusedVolumeMultiplier(');
    expect(body).toContain('Previous->SetBoolField(TEXT("allow_background_audio"), bWas);');
    expect(body).not.toContain('SaveConfig');
  });
});

describe('audio recordings name their world and their level', () => {
  it('records on the requested world audio device, keyed per device', () => {
    const start = between(audio, 'FHaybaHandlerResult RecordingStart(', 'FHaybaHandlerResult RecordingStop(');
    expect(start).toContain('RecordingWorld(P, TEXT("audio_recording_start"), Error)');
    expect(start).toContain('DeviceRecordingKey(World, Submix)');
  });

  it('reports peak and silence, and names the mute when a take is empty or silent', () => {
    const stop = between(audio, 'FHaybaHandlerResult RecordingStop(', 'FHaybaHandlerResult SetBackgroundAudio(');
    expect(stop).toContain('Out->SetNumberField(TEXT("peak"), Peak);');
    expect(stop).toContain('Out->SetBoolField(TEXT("silent"), Peak == 0.0f);');
    expect(stop).toContain('MuteCause()');
  });
});

describe('the MCP tools forward the new parameters', () => {
  const calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  beforeEach(() => {
    calls.length = 0;
    setDefaultSender((async (cmd: string, params: Record<string, unknown>) => {
      calls.push({ cmd, params });
      return { id: 'inmem', ok: true, data: { ok: true } };
    }) as Sender);
  });
  const tool = (name: string) => AUDIO_DESCRIPTORS.find((d) => d.name === name)!;

  it('editor_set_background_audio sends enabled', async () => {
    await tool('editor_set_background_audio').handler({ enabled: true }, undefined as never);
    expect(calls).toEqual([{ cmd: 'editor_set_background_audio', params: { enabled: true } }]);
  });

  it('audio_recording_start and stop send world', async () => {
    await tool('audio_recording_start').handler({ world: 'pie' }, undefined as never);
    await tool('audio_recording_stop').handler({ world: 'pie', filename: 'take' }, undefined as never);
    expect(calls[0].params).toMatchObject({ world: 'pie' });
    expect(calls[1].params).toMatchObject({ world: 'pie', filename: 'take' });
  });
});

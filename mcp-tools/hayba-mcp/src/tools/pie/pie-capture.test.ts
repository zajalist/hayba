import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startSchema, getSchema } from './pie-capture.js';

const pluginRoot = join(import.meta.dirname,
  '../../../../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private');
const cpp = readFileSync(join(pluginRoot, 'handlers/HaybaMCPPIEHandler.cpp'), 'utf8');
const commands = readFileSync(join(pluginRoot, 'HaybaMCPCommandSets.h'), 'utf8');
const policy = readFileSync(join(pluginRoot, 'HaybaPIECapturePolicy.h'), 'utf8');
const toolIndex = readFileSync(join(import.meta.dirname, '../index.ts'), 'utf8');

describe('bounded PIE capture contract', () => {
  it('validates frame bounds and capture identity at the wire boundary', () => {
    expect(startSchema.parse({})).toEqual({ sample_frames: 120, warmup_frames: 0 });
    for (const sample_frames of [0, 601, 2.5, '60']) {
      expect(startSchema.safeParse({ sample_frames }).success).toBe(false);
    }
    for (const warmup_frames of [-1, 121, 1.5, '1']) {
      expect(startSchema.safeParse({ warmup_frames }).success).toBe(false);
    }
    expect(getSchema.safeParse({ capture_id: '' }).success).toBe(false);
    expect(getSchema.safeParse({ capture_id: 'a'.repeat(65) }).success).toBe(false);
    expect(startSchema.safeParse({ actor_tag: 'a'.repeat(65) }).success).toBe(false);
  });

  it('registers both routes as PIE observation reads with no synchronous wait', () => {
    expect(commands).toContain('TEXT("editor_pie_capture_start"), TEXT("editor_pie_capture_get")');
    expect(cpp).toContain('TEXT("editor_pie_capture_start")');
    expect(cpp).toContain('TEXT("editor_pie_capture_get")');
    const start = cpp.slice(cpp.indexOf('FHaybaHandlerResult FHaybaMCPPIEHandler::PIECaptureStart'),
      cpp.indexOf('FHaybaHandlerResult FHaybaMCPPIEHandler::PIECaptureGet'));
    expect(start).toContain('AddTicker(');
    expect(start).not.toContain('Sleep(');
    expect(start).not.toContain('Tick(');
  });

  it('has bounded lifecycle and labels the evidence without inventing a verdict', () => {
    expect(policy).toContain('constexpr int32 MaxFrames = 600');
    expect(policy).toContain('constexpr int32 MaxWarmupFrames = 120');
    expect(cpp).toContain('HaybaPIECapturePolicy::ReachedTickLimit(');
    expect(cpp).toContain('FHaybaMCPEditorState::Get().PieEndSerial() == State.EndSerial');
    expect(cpp).toContain('State.World.IsValid()');
    expect(cpp).toContain('FHaybaEditorHealth::IsUnsafe()');
    expect(cpp).toContain('HaybaPIECapturePolicy::SamplesTruncated(');
    expect(cpp).toContain('observed_core_ticker_interval_whole_editor_proxy_not_pie_exclusive');
    expect(cpp).toContain('FPlatformTime::Seconds()');
    expect(cpp).toContain('const double IntervalMs = (NowSeconds - Capture->LastTickerSeconds) * 1000.0');
    expect(cpp).toContain('editor_ticker_interval_ms');
    expect(cpp).not.toContain('FApp::GetDeltaTime()');
    expect(cpp).toContain('unknown_no_pie_exclusive_measurement');
    expect(cpp).toContain('unknown_unsupported');
    expect(cpp).toContain('MaxCaptureTagActorsScanned = 5000');
    expect(cpp).toContain('count_is_lower_bound');
  });

  it('keeps unsafe-editor refusal in place and states the retrieval limit', () => {
    const unsafeAllowlist = commands.slice(
      commands.indexOf('inline const TSet<FString>& StatusOnlyCommands()'),
      commands.indexOf('inline const TSet<FString>& ControlPlaneCommands()'));
    expect(unsafeAllowlist).not.toContain('editor_pie_capture_get');
    expect(toolIndex).toContain('If the editor becomes unsafe, the safety gate refuses this command');
  });
});

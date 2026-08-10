import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const safetyH = read('unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPRenderSafety.h');
const safetyCpp = read('unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPRenderSafety.cpp');
const camera = read('unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPRenderHandler.cpp');
const widget = read('unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPUIHandler.cpp');
const capture = read('unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCaptureActor.cpp');

describe('render/RHI lifecycle source contract (#387)', () => {
  it('centralizes dimension, pixel, output, and encoded-byte limits', () => {
    expect(safetyH).toContain('MaxDimension = 4096');
    expect(safetyH).toContain('MaxPixels = 8ll * 1024ll * 1024ll');
    expect(safetyH).toContain('MaxInlinePixels = 1920ll * 1080ll');
    expect(safetyH).toContain('MaxEncodedBytes = 64ll * 1024ll * 1024ll');
    expect(camera).toContain('ValidateDimensions(');
    expect(widget).toContain('ValidateScaledDimensions(');
    expect(capture).toContain('MaxInlinePixels');
    expect(camera).not.toContain('TEXT("exr")');
  });

  it('is single-flight, deadline bounded, shutdown aware, and NullRHI honest', () => {
    expect(safetyCpp).toContain('bRenderInFlight');
    expect(safetyCpp).toContain('another render operation is in flight');
    expect(safetyCpp).toContain('IsEngineExitRequested()');
    expect(safetyCpp).toContain('GUsingNullRHI');
    expect(safetyCpp).toContain('DeadlineAtSeconds');
    expect(camera).toContain('RemainingSeconds() + 1.0');
  });

  it('detaches and releases every transient target before the lease drains', () => {
    expect(camera).toContain('Capture->TextureTarget = PreviousTarget');
    expect(camera).toContain('OperationTarget->ReleaseResource()');
    expect(capture).toContain('Capture->TextureTarget = PreviousTarget');
    expect(capture).toContain('RT->ReleaseResource()');
    expect(widget).toContain('RT->ReleaseResource()');
  });

  it('publishes through a temporary file and verifies the final artifact', () => {
    expect(safetyCpp).toContain('.hayba-');
    expect(safetyCpp).toContain('FILEWRITE_NoReplaceExisting');
    expect(safetyCpp).toContain('Move(*SafeOutPath, *TempPath, false');
    expect(safetyCpp).toContain('Saved/Screenshots/Hayba');
    expect(safetyCpp).toContain('output already exists; render artifacts never overwrite files');
    expect(safetyCpp).toContain('temporary image failed read-after-write verification');
    expect(safetyCpp).toContain('published image failed final verification');
    expect(camera).toContain('artifact_verified');
    expect(widget).toContain('artifact_verified');
  });

  it('quiesces the shared render gate before module teardown', () => {
    const module = read('unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp');
    expect(safetyH).toContain('bool BeginShutdown(');
    expect(module).toContain('HaybaRenderSafety::BeginShutdown(ActiveRender)');
    expect(module.indexOf('HaybaRenderSafety::BeginShutdown')).toBeLessThan(module.indexOf('StopTcpServer();'));
  });
});

// The native python_run policy refuses any executable `try`/`with` token
// (HCR-TIME-001). These generated-Python tools were rewritten to return explicit
// status instead; this pins that, plus the TS early crash scanner.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { PY_PREAMBLE } from '../ue-python.js';
import { scanPythonForCrashers } from '../guards/known-crashers.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';
import {
  actorInspectDescriptor,
  actorSpawnFromAssetDescriptor,
  actorBatchTransformDescriptor,
} from '../actor/actor-py-tools.js';
import { assetOpenEditorDescriptor } from '../asset/asset-py-tools.js';
import { editorGetCameraDescriptor } from '../editor/editor-py-tools.js';
import { meshGetBoundsDescriptor } from '../mesh/mesh-py-tools.js';
import { seqInspectDescriptor, seqListBindingsDescriptor, seqCameraCutDescriptor } from '../sequencer/sequencer-py-tools.js';

const cases: Array<[PyToolDescriptor, Record<string, unknown>]> = [
  [actorInspectDescriptor as unknown as PyToolDescriptor, { actor_id: 'Rock1' }],
  [actorSpawnFromAssetDescriptor as unknown as PyToolDescriptor, { asset_path: '/Game/M', label: 'L', snap_to_floor: true }],
  [actorBatchTransformDescriptor as unknown as PyToolDescriptor, { transforms: [{ actor_id: 'A', location: [1, 2, 3], rotation: [0, 0, 90], scale: [1, 1, 1] }] }],
  [assetOpenEditorDescriptor as unknown as PyToolDescriptor, { asset_paths: ['/Game/A'] }],
  [editorGetCameraDescriptor as unknown as PyToolDescriptor, {}],
  [meshGetBoundsDescriptor as unknown as PyToolDescriptor, { asset_path: '/Game/M' }],
  [seqInspectDescriptor as unknown as PyToolDescriptor, { asset_path: '/Game/FoA/Cinematics/LS_WakeUp' }],
  [seqListBindingsDescriptor as unknown as PyToolDescriptor, { asset_path: '/Game/FoA/Cinematics/LS_WakeUp' }],
  [seqCameraCutDescriptor as unknown as PyToolDescriptor, { asset_path: '/Game/LS', camera_actor: 'Cam', start_seconds: 0, end_seconds: 2, can_blend: true }],
];

/** Drop `#` comments and string literals (left-to-right, like a lexer). */
const executable = (src: string) => src.replace(/#[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, "''");

describe('generated python passes the native python_run policy', () => {
  it.each(cases.map(([d, p]) => [d.name, d, p] as const))('%s', (_name, d, params) => {
    const full = `${PY_PREAMBLE}\n${d.buildScript(z.object(d.schema).parse(params))}`;
    expect(scanPythonForCrashers(full)).toBeNull();
    expect(executable(full)).not.toMatch(/\b(try|with)\b/);
  });

  it('the stripper keeps real keywords and drops strings/comments', () => {
    expect(executable('x = "try with" # with try')).not.toMatch(/\b(try|with)\b/);
    expect(executable('a = "x %r" % r\nb = {"k": 1, "j": 2}\ntry:\n    pass')).toMatch(/\btry\b/);
  });
});

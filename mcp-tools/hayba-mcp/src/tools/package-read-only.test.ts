/**
 * package_read_only (T5): the Node code mapping, the hint kept in the payload,
 * the native refusal text, and the sidecar surface. The native behaviour is
 * covered by Hayba.MCP.Save.ReadOnly.*.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeCommand, UeToolError, type Sender } from './tool-executor.js';
import { meta as uiSaveWidgetMeta, schema as uiSaveWidgetSchema } from './ui/ui-save-widget.js';

vi.mock('./heavy-op-probe.js', () => ({ probeEditorProcess: async () => null }));

const here = dirname(fileURLToPath(import.meta.url));
const TOOLKIT = join(here, '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit');
const saveVerify = readFileSync(join(TOOLKIT, 'Public', 'HaybaMCPSaveVerify.h'), 'utf8');
const materialHandler = readFileSync(join(TOOLKIT, 'Private', 'handlers', 'HaybaMCPMaterialHandler.cpp'), 'utf8');

type SidecarEntry = {
  params: Array<{ name: string; type: string; required: boolean; default?: unknown }>;
  returns: { fields?: Array<{ name: string }> };
  notes?: string;
};
const sidecar = JSON.parse(readFileSync(join(here, '..', 'legacy-commands', 'sidecar.json'), 'utf8')) as {
  commands: Record<string, SidecarEntry>;
};

const HINT =
  'Take its source-control lock and retry: git lfs lock "Content/Blueprints/BP_Door.uasset" (or check it out in Perforce), or clear the read-only flag yourself. Hayba never clears read-only flags. Or pass save:false to compile without saving.';

const refusal: Sender = async () => ({
  id: 'x',
  ok: false,
  code: 'package_read_only',
  error: `blueprint_compile [package_read_only]: /Game/Blueprints/BP_Door cannot be saved: Content/Blueprints/BP_Door.uasset is read-only on disk. Nothing was changed. ${HINT}`,
  data: {
    ok: false,
    code: 'package_read_only',
    phase: 'preflight',
    mutation_status: 'not_started',
    make_writable_hint: HINT,
    read_only_files: ['D:/Project/Content/Blueprints/BP_Door.uasset'],
  },
});

describe('package_read_only on the wire', () => {
  it('maps to UeToolError code package_read_only', async () => {
    await expect(executeCommand('blueprint_compile', { path: '/Game/Blueprints/BP_Door' }, { sender: refusal })).rejects.toMatchObject({
      name: 'UeToolError',
      code: 'package_read_only',
    });
  });

  it('keeps the hint and the files in the payload, and the code and git lfs lock in the message', async () => {
    const err = (await executeCommand('blueprint_compile', { path: '/Game/Blueprints/BP_Door' }, { sender: refusal }).catch(
      (e: unknown) => e,
    )) as InstanceType<typeof UeToolError>;
    expect(err.message).toContain('[package_read_only]');
    expect(err.message).toContain('git lfs lock');
    const payload = err.uePayload as { data: { make_writable_hint: string; read_only_files: string[] } };
    expect(payload.data.make_writable_hint).toBe(HINT);
    expect(payload.data.read_only_files).toHaveLength(1);
  });
});

describe('the native refusal text', () => {
  it('names the code, the file, git lfs lock, and that Hayba never clears read-only flags', () => {
    expect(saveVerify).toContain('PackageReadOnlyCode = TEXT("package_read_only")');
    expect(saveVerify).toContain('%s [package_read_only]: %s cannot be saved: %s is read-only on disk. Nothing was changed. %s');
    expect(saveVerify).toContain('git lfs lock \\"%s\\"');
    expect(saveVerify).toContain('Hayba never clears read-only flags.');
    expect(saveVerify).toContain('MaxHintChars = 480');
  });

  it('HaybaPersistAsset prefixes its error with [package_read_only]', () => {
    expect(materialHandler).toContain('OutError = TEXT("[package_read_only] ") + Saved.Note;');
  });
});

describe('sidecar and descriptors', () => {
  it('blueprint_compile takes save (boolean, default true) and returns saved, save_error and save_error_code', () => {
    const entry = sidecar.commands.blueprint_compile!;
    expect(entry.params).toContainEqual(expect.objectContaining({ name: 'save', type: 'boolean', required: false, default: true }));
    const fields = (entry.returns.fields ?? []).map((f) => f.name);
    expect(fields).toEqual(expect.arrayContaining(['compiled', 'errors', 'saved', 'save_error', 'save_error_code']));
  });

  it.each(['blueprint_compile', 'metasound_compile', 'create_graph', 'level_save', 'audio_asset_save', 'editor_save_all_and_quit'])(
    '%s notes mention package_read_only',
    (name) => {
      expect(sidecar.commands[name]!.notes).toContain('package_read_only');
    },
  );

  it('level_save notes include clean packages requiring transient-reference repair', () => {
    expect(sidecar.commands.level_save!.notes).toContain('clean packages');
    expect(sidecar.commands.level_save!.notes).toContain('transient-reference repair');
  });

  it('ui_save_widget (a TS descriptor, no sidecar entry) mentions package_read_only', () => {
    expect(uiSaveWidgetMeta.not_when).toContain('package_read_only');
    expect(uiSaveWidgetSchema.shape.widget_blueprint_path.description).toContain('package_read_only');
  });
});

/**
 * a production project crash, 2026-11-05 23:37: material_set_property switched M_UI_SandText to MD_UI + translucent
 * while its shaders were still compiling for the old settings. The next render of the material (an
 * editor-autosave thumbnail) failed MaterialShader.cpp:2567 (ContainsShaderType) and killed the editor.
 * The handler must drop the stale compile before it mutates shader-deciding settings and recompile
 * for the new ones, behind the SEH guard, before it returns. This pins that order in the source.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const handler = readFileSync(
  join(here, '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers',
    'HaybaMCPMaterialHandler.cpp'),
  'utf8',
);
const start = handler.indexOf('FHaybaHandlerResult FHaybaMCPMaterialHandler::MatSetProperty(');
const body = handler.slice(start, handler.indexOf('\n}\n', handler.indexOf('struct FOrdinarySnapshot', start)));

describe('material_set_property keeps the shader map consistent with the settings it changes', () => {
  it('cancels the stale compile before the first ordinary-setting write', () => {
    const cancel = body.indexOf('Mat->CancelOutstandingCompilation();');
    expect(cancel).toBeGreaterThan(-1);
    expect(cancel).toBeLessThan(body.indexOf('Mat->MaterialDomain = Value;'));
  });

  it('recompiles for the new settings behind the SEH guard before answering', () => {
    const recompile = body.indexOf('UMaterialEditingLibrary::RecompileMaterial(');
    expect(recompile).toBeGreaterThan(body.indexOf('Mat->MaterialDomain = Value;'));
    expect(body.lastIndexOf('HaybaSeh::RunGuarded(', recompile)).toBeGreaterThan(-1);
    expect(recompile).toBeLessThan(body.lastIndexOf('return FHaybaHandlerResult::Ok(Out);'));
  });
});

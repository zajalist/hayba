import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const handler = readFileSync(
  join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPMaterialHandler.cpp'),
  'utf8',
);
const apply = handler.slice(handler.indexOf('static FApplyNodePropsResult ApplyNodeProps('));
const body = apply.slice(0, apply.indexOf('\n    return R;'));

describe('staged node edits rebuild what PostEditChangeProperty would', () => {
  // Custom pins come from AdditionalOutputs only via PostEditChangeProperty -> RebuildOutputs,
  // which staged edits skip; without it connect from output 1+ fails with "out of range (1 outputs)".
  it('rebuilds a Custom node\'s outputs after the property passthrough', () => {
    const custom = body.indexOf('Cast<UMaterialExpressionCustom>(Expr)');
    expect(custom).toBeGreaterThan(body.indexOf('HaybaReflection::SetProp(Expr, Key, Pair.Value)'));
    expect(body.slice(custom)).toContain('Cu->RebuildOutputs();');
    expect(body.slice(custom)).toContain('Name.ReplaceInline(TEXT(" "), TEXT(""))');
  });

  // Re-setting the same function skips SetMaterialFunction's output fixup and can miswire links.
  it('refreshes a call to the same function without re-setting it', () => {
    expect(body).toContain('if (Fc->MaterialFunction != Fn)\n                    Fc->SetMaterialFunction(Fn);');
    expect(body).toContain('Fc->UpdateFromFunctionResource();');
  });
});

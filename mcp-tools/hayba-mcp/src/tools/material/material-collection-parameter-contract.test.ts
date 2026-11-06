import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const handler = readFileSync(
  join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPMaterialHandler.cpp'),
  'utf8',
);

describe('collection parameter nodes resolve their ParameterId', () => {
  // Staged edits skip PostEditChangeProperty, which is where the editor derives the id;
  // without it the compile fails with "CollectionParameter has invalid parameter <Name>".
  it('derives the id from the collection after every staged edit', () => {
    const apply = handler.slice(handler.indexOf('static FApplyNodePropsResult ApplyNodeProps('));
    const body = apply.slice(0, apply.indexOf('\n    return R;'));
    expect(body).toContain('Cast<UMaterialExpressionCollectionParameter>(Expr)');
    expect(body).toContain('CP->ParameterId = CP->Collection ? CP->Collection->GetParameterId(CP->ParameterName) : FGuid()');
    // A name the collection lacks is reported, not silently left unresolved.
    expect(body).toContain('is not a parameter of');
  });

  it('get_info says whether a collection parameter is actually resolved', () => {
    expect(handler).toContain('TEXT("collection_parameter_resolved")');
    expect(handler).toContain('CP->Collection->GetParameterId(CP->ParameterName) == CP->ParameterId');
  });
});

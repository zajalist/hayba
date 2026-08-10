import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const source = readFileSync(join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPBlueprintHandler.cpp'), 'utf8');

describe('Blueprint event-graph authoring contract', () => {
  it('exports exact nodes, pins and edges before mutation', () => {
    expect(source).toContain('blueprint_inspect_graph');
    expect(source).toContain('HaybaDescribeNode(Node)');
    expect(source).toContain('Linked->GetOwningNode()->NodeGuid');
  });

  it.each(['branch', 'select', 'timer_by_function', 'call_function'])(
    'supports %s nodes', (kind) => expect(source).toContain(`TEXT("${kind}")`),
  );

  it('uses schema-checked pin connections and defaults', () => {
    expect(source).toContain('Schema->CanCreateConnection');
    expect(source).toContain('Schema->TryCreateConnection');
    expect(source).toContain('Schema->TrySetDefaultValue');
  });

  it('saves only after a clean explicit compile', () => {
    expect(source).toMatch(/if \(bOk && bSave\)[\s\S]*UPackage::SavePackage/);
  });
});

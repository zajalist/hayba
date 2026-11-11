/**
 * face, 2026-11-10: actor_find was refused by python_run's own policy (HCR-TIME-001, "try statement"). The policy is
 * right: a try/except or with block can keep running after CPython disables the cooperative deadline hook, so native
 * python_run refuses them. The tool's template was wrong. No actor template may contain one, and no other python_run
 * template file may add one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  actorBatchTransformDescriptor,
  actorFindDescriptor,
  actorFocusDescriptor,
  actorGetSelectionDescriptor,
  actorInspectDescriptor,
  actorSetFolderDescriptor,
  actorSetSelectionDescriptor,
  actorSpawnFromAssetDescriptor,
} from './actor-py-tools.js';

// What native python_run refuses: a try or with statement. Strings and comments are removed first, as the native
// lexer only looks at identifiers.
function refusedStatement(script: string): string | null {
  const code = script
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/#.*$/gm, '');
  const m = code.match(/(?:^|[\s;:])(try|with)\b/m);
  return m ? m[1]! : null;
}

describe('actor python_run templates never use try or with', () => {
  const cases: Array<[string, { buildScript: (p: never) => string }, Record<string, unknown>]> = [
    ['actor_find', actorFindDescriptor as never, { label_contains: 'Lamp', limit: 10, offset: 0 }],
    ['actor_find near', actorFindDescriptor as never, { near: [0, 0, 0], radius_cm: 500, limit: 10, offset: 0 }],
    ['actor_inspect', actorInspectDescriptor as never, { actor_id: 'Lamp' }],
    ['actor_get_selection', actorGetSelectionDescriptor as never, {}],
    ['actor_set_selection', actorSetSelectionDescriptor as never, { actor_ids: ['Lamp', 'Desk'] }],
    ['actor_spawn_from_asset', actorSpawnFromAssetDescriptor as never, { asset_path: '/Game/M', location: [0, 0, 0] }],
    ['actor_batch_transform', actorBatchTransformDescriptor as never, { transforms: [{ actor_id: 'Lamp', location: [0, 0, 0] }] }],
    ['actor_focus', actorFocusDescriptor as never, { actor_id: 'Lamp' }],
    ['actor_set_folder', actorSetFolderDescriptor as never, { actor_ids: ['Lamp'], folder: 'Props' }],
  ];
  for (const [name, descriptor, args] of cases) {
    it(`${name}`, () => {
      expect(refusedStatement(descriptor.buildScript(args as never))).toBeNull();
    });
  }
});

describe('no python_run template file has a try or with', () => {
  // Every source file under src/tools, not only *-py-tools.ts: pcg, introspect and others build python_run scripts too.
  const tools = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const f of readdirSync(join(tools, rel))) {
      const r = rel ? `${rel}/${f}` : f;
      if (statSync(join(tools, r)).isDirectory()) walk(r);
      else if (f.endsWith('.ts') && !f.endsWith('.test.ts')) files.push(r);
    }
  };
  walk('');
  it('finds the template files', () => {
    for (const f of ['actor/actor-py-tools.ts', 'pcg/pcg-primitives.ts', 'introspect/hayba-introspect.ts',
      'pcg/pcg-scatter-mesh.ts', 'pcg/pcg-cook-and-wait.ts']) expect(files).toContain(f);
  });
  for (const file of files) {
    it(`${file} has no template line starting a try or with block`, () => {
      const src = readFileSync(join(tools, file), 'utf8');
      expect(src).not.toMatch(/^\s*'\s*(try:|with\s)/m);
    });
  }
});

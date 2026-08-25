import { describe, it, expect } from 'vitest';
import { actorPyDescriptors } from '../actor/actor-py-tools.js';
import { assetPyDescriptors } from '../asset/asset-py-tools.js';

/**
 * Descriptor arrays are declared as object literals and then forced into their
 * type with `as unknown as PyToolDescriptor[]`.
 *
 * Unlike the validator projection that dropped the signed margin, this cast is
 * JUSTIFIED: PyToolDescriptor is generic over its schema shape and buildScript
 * is contravariant in its params, so a heterogeneous array of differently
 * parameterised descriptors cannot be typed as PyToolDescriptor[] without one.
 * Removing it produces a genuine variance error, not a fixable mistake.
 *
 * But a justified cast is still an unchecked one. TypeScript cannot verify
 * these descriptors, so something has to, and that is what this does.
 *
 * It asserts the fields the factory actually reads. A descriptor missing one
 * does not fail to compile; it fails when someone calls the tool.
 */
const SUITES: Array<[string, readonly unknown[]]> = [
  ['actor', actorPyDescriptors],
  ['asset', assetPyDescriptors],
];

describe('py tool descriptors keep the shape their cast claims', () => {
  for (const [label, tools] of SUITES) {
    it(`${label}: every descriptor has the fields the factory reads`, () => {
      expect(tools.length).toBeGreaterThan(0);

      for (const t of tools as Array<Record<string, unknown>>) {
        const name = typeof t.name === 'string' ? t.name : '(unnamed)';

        expect(typeof t.name, `${name}: name`).toBe('string');
        expect(t.name, `${name}: name is not empty`).not.toBe('');
        expect(typeof t.description, `${name}: description`).toBe('string');
        expect(typeof t.cost, `${name}: cost`).toBe('string');
        // returns feeds get_tool_signature; without it the signature test that
        // covers legacy commands has no equivalent guard here.
        expect(typeof t.returns, `${name}: returns`).toBe('string');
        expect(t.schema, `${name}: schema`).toBeTypeOf('object');
        expect(typeof t.buildScript, `${name}: buildScript`).toBe('function');
      }
    });

    it(`${label}: tool names are unique`, () => {
      const names = (tools as Array<{ name: string }>).map(t => t.name);
      expect(new Set(names).size, `duplicate name in ${label}`).toBe(names.length);
    });
  }
});

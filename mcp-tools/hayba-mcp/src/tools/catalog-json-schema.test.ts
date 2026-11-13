import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { STATIC_TOOL_CATALOGUE } from './index.js';

describe('published MCP catalogue schemas', () => {
  it('serializes every wire schema without an unrepresentable custom type', () => {
    for (const descriptor of STATIC_TOOL_CATALOGUE) {
      expect(() => z.toJSONSchema(z.object(descriptor.wireSchema ?? descriptor.schema), { io: 'input' }),
        descriptor.name).not.toThrow();
    }
  });

  it('publishes bounded simulation and scatter inputs as numbers', () => {
    for (const [name, field] of [['niagara_advance_simulation', 'seconds'], ['foliage_scatter_paint', 'radius']]) {
      const descriptor = STATIC_TOOL_CATALOGUE.find(tool => tool.name === name)!;
      const schema = z.toJSONSchema(z.object(descriptor.schema), { io: 'input' });
      expect(schema.properties?.[field]).toMatchObject({ type: 'number' });
      for (const value of [NaN, Infinity, -Infinity, '1', null]) {
        const parsed = z.object({ value: descriptor.schema[field] }).safeParse({ value });
        expect(parsed.success).toBe(false);
        if (!parsed.success) expect(parsed.error.message).toContain('bounded_work_limit');
      }
    }
  });
});

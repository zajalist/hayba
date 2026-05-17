import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { recordSchema, listRecordedCommands, deriveSignature } from '../../src/tools/schema-registry.js';

describe('schema-registry', () => {
  beforeEach(() => {
    for (const cmd of listRecordedCommands()) {
      recordSchema(cmd, { shape: {}, cost: 'low', returns: 'void' });
    }
  });

  it('records and retrieves a command schema', () => {
    recordSchema('test_cmd', {
      shape: { name: z.string() },
      cost: 'low',
      returns: '{ok:true}',
    });
    const sig = deriveSignature('test_cmd');
    expect(sig).not.toBeNull();
    expect(sig!.cost).toBe('low');
    expect(sig!.returns).toBe('{ok:true}');
    expect(sig!.params.name).toContain('string');
  });

  it('returns null for unknown command', () => {
    expect(deriveSignature('nonexistent')).toBeNull();
  });

  it('lists all recorded command names', () => {
    recordSchema('cmd_a', { shape: {}, cost: 'low', returns: '' });
    recordSchema('cmd_b', { shape: {}, cost: 'high', returns: '' });
    const names = listRecordedCommands();
    expect(names).toContain('cmd_a');
    expect(names).toContain('cmd_b');
  });

  it('describes optional params correctly', () => {
    recordSchema('opt_test', {
      shape: {
        required_field: z.string(),
        optional_field: z.string().optional(),
      },
      cost: 'medium',
      returns: 'void',
    });
    const sig = deriveSignature('opt_test');
    expect(sig!.params.required_field).toContain('(required)');
    expect(sig!.params.optional_field).toContain('(optional)');
  });

  it('describes enum params', () => {
    recordSchema('enum_test', {
      shape: {
        mode: z.enum(['a', 'b', 'c']),
      },
      cost: 'low',
      returns: 'void',
    });
    const sig = deriveSignature('enum_test');
    expect(sig!.params.mode).toContain('"a"');
    expect(sig!.params.mode).toContain('(required)');
  });

  it('describes preprocessed (coerced) types', () => {
    recordSchema('coerce_test', {
      shape: {
        flag: z.preprocess((v) => v === 'true', z.boolean()),
      },
      cost: 'low',
      returns: 'void',
    });
    const sig = deriveSignature('coerce_test');
    expect(sig!.params.flag).toContain('bool');
  });

  it('handles objects and arrays', () => {
    recordSchema('complex_test', {
      shape: {
        filter: z.object({ min: z.number(), max: z.number() }).optional(),
        tags: z.array(z.string()),
      },
      cost: 'high',
      returns: '{items:[]}',
    });
    const sig = deriveSignature('complex_test');
    expect(sig!.params.filter).toContain('object');
    expect(sig!.params.filter).toContain('(optional)');
    expect(sig!.params.tags).toContain('string');
    expect(sig!.params.tags).toContain('(required)');
    expect(sig!.params.tags).toContain('[]');
  });
});

import { describe, it, expect } from 'vitest';
import { STATIC_TOOL_CATALOGUE } from '../index.js';

// A tool that exists in a file but never reaches the catalogue is the exact
// dead code this session has spent its time deleting. Registration is the
// difference between "built" and "usable", so it gets an assertion.
describe('the visual tools are actually reachable', () => {
  it('asset_find_by_look is in the catalogue an agent sees', () => {
    const names = STATIC_TOOL_CATALOGUE.map((d) => d.name);
    expect(names).toContain('asset_find_by_look');
  });

  it('carries a schema and a handler, not just a name', () => {
    const d = STATIC_TOOL_CATALOGUE.find((x) => x.name === 'asset_find_by_look');
    expect(d?.handler).toBeTypeOf('function');
    expect(Object.keys(d?.schema ?? {})).toContain('intent');
  });
});

describe('the grammar executor is reachable too', () => {
  it('plumb_plan_build is in the catalogue', () => {
    const names = STATIC_TOOL_CATALOGUE.map((d) => d.name);
    expect(names).toContain('plumb_plan_build');
  });

  it('takes a plan and bindings, so a caller can tell what it needs', () => {
    const d = STATIC_TOOL_CATALOGUE.find((x) => x.name === 'plumb_plan_build');
    const keys = Object.keys(d?.schema ?? {});
    expect(keys).toContain('plan');
    expect(keys).toContain('bindings');
  });
});

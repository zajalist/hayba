/**
 * No-drift invariant tests for the single-source tool descriptor pattern.
 *
 * For every tool that has been migrated from the double-declaration pattern
 * (server.tool + reg) into STANDARD_DESCRIPTORS, these tests assert:
 *
 *   1. The tool's descriptor exists in STANDARD_DESCRIPTORS (schema declared once).
 *   2. After recording the descriptor, deriveSignature returns the expected params.
 *
 * If a migrated tool's schema ever diverges between the descriptor and a
 * secondary declaration, adding a reg() call would be caught by test (2) showing
 * stale or duplicate params (if the registry is re-recorded).
 *
 * Note: pcg_cook_and_wait is a 3-step TS orchestrator (python generate →
 * wait_for_idle → python inspect) and is intentionally left hand-written.
 * The remaining ergonomics tools (hayba_introspect, pcg_add_node, pcg_set_prop,
 * pcg_wire, pcg_inspect_instances) are expressed as PyToolDescriptors and
 * adapted via toToolDescriptor into STANDARD_DESCRIPTORS (Task 8).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { STANDARD_DESCRIPTORS } from './index.js';
import { recordToolSchema } from './register-tool.js';
import { deriveSignature } from './schema-registry.js';

// Populate the schema registry from STANDARD_DESCRIPTORS before any test runs.
// This mirrors exactly what recordEagerSchemas does:
//   for (const d of STANDARD_DESCRIPTORS) recordToolSchema(d);
beforeAll(() => {
  for (const d of STANDARD_DESCRIPTORS) {
    recordToolSchema(d);
  }
});

/** Find a descriptor by name and assert it's present. */
function getDescriptor(name: string) {
  const d = STANDARD_DESCRIPTORS.find((x) => x.name === name);
  expect(d, `${name} must be in STANDARD_DESCRIPTORS`).toBeDefined();
  return d!;
}

// ── editor domain ───────────────────────────────────────────────────────────

describe('single-source migration: editor_start_pie', () => {
  it('is present in STANDARD_DESCRIPTORS', () => {
    const d = getDescriptor('editor_start_pie');
    expect(d.schema).toHaveProperty('single_step');
  });

  it('deriveSignature returns single_step param after recordToolSchema', () => {
    const sig = deriveSignature('editor_start_pie');
    expect(sig).not.toBeNull();
    expect(sig!.params).toHaveProperty('single_step');
    expect(sig!.params['single_step']).toMatch(/\(optional\)/);
    expect(sig!.cost).toBe('high');
    expect(sig!.returns).toContain('pie_world_id');
  });
});

// ── wait / capture helpers ──────────────────────────────────────────────────

describe('single-source migration: wait_for_shaders', () => {
  it('is present in STANDARD_DESCRIPTORS', () => {
    const d = getDescriptor('wait_for_shaders');
    expect(d.schema).toHaveProperty('max_seconds');
    expect(d.schema).toHaveProperty('poll_seconds');
  });

  it('deriveSignature returns expected params', () => {
    const sig = deriveSignature('wait_for_shaders');
    expect(sig).not.toBeNull();
    expect(sig!.params['max_seconds']).toMatch(/\(optional\)/);
    expect(sig!.params['poll_seconds']).toMatch(/\(optional\)/);
    expect(sig!.cost).toBe('high');
  });
});

describe('single-source migration: wait_for_idle', () => {
  it('is present in STANDARD_DESCRIPTORS', () => {
    const d = getDescriptor('wait_for_idle');
    expect(d.schema).toHaveProperty('timeout_s');
    expect(d.schema).toHaveProperty('subsystems');
  });

  it('deriveSignature returns subsystems and timeout_s', () => {
    const sig = deriveSignature('wait_for_idle');
    expect(sig).not.toBeNull();
    expect(sig!.params).toHaveProperty('subsystems');
    expect(sig!.params).toHaveProperty('timeout_s');
    expect(sig!.cost).toBe('high');
  });
});

describe('single-source migration: render_camera', () => {
  it('is present in STANDARD_DESCRIPTORS', () => {
    const d = getDescriptor('render_camera');
    expect(d.schema).toHaveProperty('camera');
    expect(d.schema).toHaveProperty('format');
    expect(d.schema).toHaveProperty('force');
  });

  it('deriveSignature returns camera and format params', () => {
    const sig = deriveSignature('render_camera');
    expect(sig).not.toBeNull();
    expect(sig!.params).toHaveProperty('camera');
    expect(sig!.params).toHaveProperty('format');
    expect(sig!.cost).toBe('high');
  });
});

// ── fab connector domain ────────────────────────────────────────────────────

describe('single-source migration: fab tools', () => {
  const fabTools = [
    'hayba_fab_login_status',
    'hayba_fab_library_list',
    'hayba_fab_marketplace_search',
    'hayba_fab_download',
  ];

  for (const name of fabTools) {
    it(`${name} is in STANDARD_DESCRIPTORS`, () => {
      getDescriptor(name);
    });

    it(`${name} deriveSignature returns non-null signature`, () => {
      const sig = deriveSignature(name);
      expect(sig, `${name} must be derivable`).not.toBeNull();
      expect(sig!.cost).toBeDefined();
    });
  }

  it('hayba_fab_library_list has count and page params', () => {
    const sig = deriveSignature('hayba_fab_library_list');
    expect(sig!.params).toHaveProperty('count');
    expect(sig!.params).toHaveProperty('page');
    expect(sig!.params['count']).toMatch(/\(optional\)/);
  });

  it('hayba_fab_download has asset_id (required)', () => {
    const sig = deriveSignature('hayba_fab_download');
    expect(sig!.params['asset_id']).toMatch(/\(required\)/);
  });
});

// ── asset-source connectors ─────────────────────────────────────────────────

describe('single-source migration: asset-source tools', () => {
  const sourceTools = [
    'hayba_polyhaven_search',
    'hayba_polyhaven_download',
    'hayba_ambientcg_search',
    'hayba_ambientcg_download',
    'hayba_sketchfab_search',
    'hayba_sketchfab_download',
  ];

  for (const name of sourceTools) {
    it(`${name} is in STANDARD_DESCRIPTORS`, () => {
      getDescriptor(name);
    });

    it(`${name} deriveSignature returns non-null signature`, () => {
      const sig = deriveSignature(name);
      expect(sig, `${name} must be derivable`).not.toBeNull();
    });
  }

  it('hayba_polyhaven_search has query (required) and type (optional)', () => {
    const sig = deriveSignature('hayba_polyhaven_search');
    expect(sig!.params['query']).toMatch(/\(required\)/);
    expect(sig!.params['type']).toMatch(/\(optional\)/);
  });

  it('hayba_sketchfab_download has uid (required)', () => {
    const sig = deriveSignature('hayba_sketchfab_download');
    expect(sig!.params['uid']).toMatch(/\(required\)/);
  });
});

// ── agent-ergonomics tools (pyTemplate factory, Task 8) ────────────────────

describe('single-source migration: hayba_introspect (via pyTemplate factory)', () => {
  it('is present in STANDARD_DESCRIPTORS', () => {
    const d = getDescriptor('hayba_introspect');
    expect(d.schema).toHaveProperty('mode');
    expect(d.schema).toHaveProperty('settings_class');
  });

  it('deriveSignature returns expected params', () => {
    const sig = deriveSignature('hayba_introspect');
    expect(sig).not.toBeNull();
    expect(sig!.cost).toBe('low');
    // `mode` is optional AND defaulted, so it also names the default (#322).
    expect(sig!.params['mode']).toMatch(/\(optional/);
    expect(sig!.params['mode']).toContain('default: "auto"');
    expect(sig!.params['settings_class']).toMatch(/\(optional/);
    expect(sig!.returns).toContain('input_pins');
  });
});

describe('single-source migration: pcg_add_node (via pyTemplate factory)', () => {
  it('is present in STANDARD_DESCRIPTORS', () => {
    const d = getDescriptor('pcg_add_node');
    expect(d.schema).toHaveProperty('graph');
    expect(d.schema).toHaveProperty('settings_class');
  });

  it('deriveSignature returns expected params', () => {
    const sig = deriveSignature('pcg_add_node');
    expect(sig).not.toBeNull();
    expect(sig!.cost).toBe('low');
    expect(sig!.params['graph']).toMatch(/\(required\)/);
    expect(sig!.params['settings_class']).toMatch(/\(required\)/);
    expect(sig!.returns).toContain('node_index');
  });
});

describe('single-source migration: pcg_set_prop (via pyTemplate factory)', () => {
  it('is present in STANDARD_DESCRIPTORS', () => {
    const d = getDescriptor('pcg_set_prop');
    expect(d.schema).toHaveProperty('path');
    expect(d.schema).toHaveProperty('node');
  });

  it('deriveSignature returns expected params', () => {
    const sig = deriveSignature('pcg_set_prop');
    expect(sig).not.toBeNull();
    expect(sig!.cost).toBe('low');
    expect(sig!.params['graph']).toMatch(/\(required\)/);
    expect(sig!.params['path']).toMatch(/\(required\)/);
    expect(sig!.returns).toContain('node_label');
  });
});

describe('single-source migration: pcg_wire (via pyTemplate factory)', () => {
  it('is present in STANDARD_DESCRIPTORS', () => {
    const d = getDescriptor('pcg_wire');
    expect(d.schema).toHaveProperty('from_node');
    expect(d.schema).toHaveProperty('to_node');
  });

  it('deriveSignature returns expected params', () => {
    const sig = deriveSignature('pcg_wire');
    expect(sig).not.toBeNull();
    expect(sig!.cost).toBe('low');
    // Both are defaulted pin labels, so both name their default (#322).
    expect(sig!.params['from_pin']).toContain('default: "Out"');
    expect(sig!.params['to_pin']).toMatch(/\(optional/);
    expect(sig!.returns).toContain('from_pin');
  });
});

describe('single-source migration: pcg_inspect_instances (via pyTemplate factory)', () => {
  it('is present in STANDARD_DESCRIPTORS', () => {
    const d = getDescriptor('pcg_inspect_instances');
    expect(d.schema).toHaveProperty('actor');
  });

  it('deriveSignature returns expected params', () => {
    const sig = deriveSignature('pcg_inspect_instances');
    expect(sig).not.toBeNull();
    expect(sig!.cost).toBe('low');
    expect(sig!.params['actor']).toMatch(/\(required\)/);
    expect(sig!.returns).toContain('ism');
  });
});

// ── no-double-declaration structural invariant ──────────────────────────────

describe('no-double-declaration invariant', () => {
  const migratedNames = new Set([
    'editor_start_pie',
    'wait_for_shaders',
    'wait_for_idle',
    'render_camera',
    'hayba_fab_login_status',
    'hayba_fab_library_list',
    'hayba_fab_marketplace_search',
    'hayba_fab_download',
    'hayba_polyhaven_search',
    'hayba_polyhaven_download',
    'hayba_ambientcg_search',
    'hayba_ambientcg_download',
    'hayba_sketchfab_search',
    'hayba_sketchfab_download',
    // Task 8: python-factory tools
    'hayba_introspect',
    'pcg_add_node',
    'pcg_set_prop',
    'pcg_wire',
    'pcg_inspect_instances',
  ]);

  it('every migrated tool appears exactly once in STANDARD_DESCRIPTORS', () => {
    for (const name of migratedNames) {
      const matches = STANDARD_DESCRIPTORS.filter((d) => d.name === name);
      expect(matches.length, `${name} must appear exactly once`).toBe(1);
    }
  });

  it('STANDARD_DESCRIPTORS has no duplicate tool names', () => {
    const seen = new Set<string>();
    for (const d of STANDARD_DESCRIPTORS) {
      expect(seen.has(d.name), `duplicate: ${d.name}`).toBe(false);
      seen.add(d.name);
    }
  });
});

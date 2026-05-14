import { describe, it, expect } from 'vitest';
import { parseResponse } from './response-parser.js';
import { loadElementCatalog } from '../index.js';

const element = loadElementCatalog().elementsById.get('column')!;

const validJson = JSON.stringify({
  profiles: {
    shaft:          '<svg viewBox="0 0 200 1000"><path d="M0 0 L 100 0 L 100 1000 L 0 1000 Z"/></svg>',
    base:           '<svg viewBox="0 0 300 80"><path d="M0 0 L 150 0 L 150 80 L 0 80 Z"/></svg>',
    capital_bottom: '<svg viewBox="-100 -100 200 200"><path d="M-50 -50 L 50 -50 L 50 50 L -50 50 Z"/></svg>',
    capital_top:    '<svg viewBox="-150 -150 300 300"><path d="M-100 -100 L 100 -100 L 100 100 L -100 100 Z"/></svg>',
  },
  params: { base_height_m: 0.2, shaft_height_m: 3.0, capital_height_m: 0.3, revolve_segments: 32 },
  rationale: 'A simple test column.',
});

describe('parseResponse', () => {
  it('parses well-formed JSON into a binding draft', () => {
    const r = parseResponse(validJson, element, 'medieval-european-gothic', 0x42n, 'mock', 'mock-model', 'deadbeef');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.draft.elementId).toBe('column');
      expect(r.draft.styleSheetId).toBe('medieval-european-gothic');
      expect(r.draft.seed).toBe(0x42n);
      expect(r.draft.provenance.source).toBe('ai');
      expect(r.draft.provenance.aiProvider).toBe('mock');
      expect(r.draft.provenance.promptHash).toBe('deadbeef');
      expect(r.rationale).toBe('A simple test column.');
    }
  });

  it('strips ```json ... ``` fences if present', () => {
    const fenced = '```json\n' + validJson + '\n```';
    const r = parseResponse(fenced, element, 'medieval-european-gothic', 1n, 'mock', 'm', 'h');
    expect(r.ok).toBe(true);
  });

  it('strips leading commentary before JSON', () => {
    const noisy = 'Here is your binding:\n\n' + validJson;
    const r = parseResponse(noisy, element, 'medieval-european-gothic', 1n, 'mock', 'm', 'h');
    expect(r.ok).toBe(true);
  });

  it('returns parse error for invalid JSON', () => {
    const r = parseResponse('not json at all', element, 'medieval-european-gothic', 1n, 'mock', 'm', 'h');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe('parse');
  });

  it('returns validate error for out-of-range param', () => {
    const bad = JSON.parse(validJson);
    bad.params.shaft_height_m = 100;
    const r = parseResponse(JSON.stringify(bad), element, 'medieval-european-gothic', 1n, 'mock', 'm', 'h');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe('validate');
  });

  it('returns svg-parse error for malformed SVG profile', () => {
    const bad = JSON.parse(validJson);
    bad.profiles.shaft = '<svg viewBox="0 0 100 100"><path d="this is not a path"/></svg>';
    const r = parseResponse(JSON.stringify(bad), element, 'medieval-european-gothic', 1n, 'mock', 'm', 'h');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe('svg-parse');
  });
});

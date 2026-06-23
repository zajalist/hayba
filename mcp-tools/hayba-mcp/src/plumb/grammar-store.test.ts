import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setGrammarPath, putProduction, listProductions, validateProduction } from './index.js';

describe('grammar store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gram-'));
    setGrammarPath(join(dir, 'grammar.json'));
  });
  afterEach(() => {
    setGrammarPath(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a production', () => {
    putProduction({
      id: 'P_x',
      lhs: { kind: 'tunnel' },
      rhs: [{ emit: 'shell', role: 'wall' }],
      guards: [],
      priority: 10,
    });
    expect(listProductions().map(p => p.id)).toEqual(['P_x']);
  });

  it('rejects an invalid emit op', () => {
    const errs = validateProduction({
      id: 'P_bad',
      lhs: { kind: 'tunnel' },
      rhs: [{ emit: 'nope' } as any],
      guards: [],
      priority: 1,
    });
    expect(errs.length).toBeGreaterThan(0);
  });
});

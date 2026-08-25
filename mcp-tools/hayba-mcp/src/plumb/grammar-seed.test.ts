import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProductions, setGrammarPath } from './grammar-store.js';

// plumb_grammar_expand answers an unseeded store with an empty plan and "call
// plumb_production_define to author rules" -- which asks someone to write a
// grammar before they have ever seen one work. The starter set is the same one
// the room-grammar tests are written against, so what ships is what is proven.

let dir: string;
const ENV = process.env.HAYBA_GRAMMAR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hayba-grammar-seed-'));
  delete process.env.HAYBA_GRAMMAR;
  setGrammarPath(null);
});

afterEach(() => {
  setGrammarPath(null);
  if (ENV === undefined) delete process.env.HAYBA_GRAMMAR;
  else process.env.HAYBA_GRAMMAR = ENV;
  rmSync(dir, { recursive: true, force: true });
});

describe('the starter grammar', () => {
  it('appears on a first run, so expansion has something to say', () => {
    const cwd = process.cwd();
    process.chdir(dir); // the default path derives from cwd/.scratch
    try {
      const prods = listProductions();

      expect(prods.length).toBeGreaterThan(0);
      expect(prods.map((p) => p.id)).toContain('P_room_imperial');
      expect(existsSync(join(dir, '.scratch', 'grammar.json'))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it('does not come back after the user clears it', () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      listProductions();                       // seeds
      const path = join(dir, '.scratch', 'grammar.json');
      writeFileSync(path, '{}', 'utf-8');      // user deletes every production

      // Re-seeding here would be the store overruling a deliberate choice.
      expect(listProductions()).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });

  it('leaves an explicitly named grammar alone', () => {
    const named = join(dir, 'mine.json');
    setGrammarPath(named);

    // A caller that names a path wants that file, not a starter set folded in.
    expect(listProductions()).toEqual([]);
    expect(existsSync(named)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  INVENTORIES,
  loadInventoriesFromPhoible,
  loadPhoibleCorpus,
  parseCsvLine,
} from './inventories.js';

async function withTempCsv(body: string, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'hayba-phoible-'));
  const path = join(dir, 'phoible.csv');
  await writeFile(path, body, 'utf8');
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('parseCsvLine', () => {
  it('parses unquoted fields', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('preserves commas inside quoted fields', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsvLine('a,"he said ""hi""",b')).toEqual(['a', 'he said "hi"', 'b']);
  });
});

describe('loadInventoriesFromPhoible', () => {
  const HEADER =
    'InventoryID,LanguageName,Glottocode,ISO6393,Phoneme,Family_Name,family_id';

  it('groups rows by InventoryID into one record per inventory', async () => {
    const body = [
      HEADER,
      '1,Tinyish,tiny1234,tny,p,Indo-European,indo1319',
      '1,Tinyish,tiny1234,tny,t,Indo-European,indo1319',
      '1,Tinyish,tiny1234,tny,k,Indo-European,indo1319',
      '2,Otherish,othe1234,oth,m,Austronesian,aust1307',
      '2,Otherish,othe1234,oth,a,Austronesian,aust1307',
      '3,Thirdish,thir1234,thi,s,Niger-Congo,nige1235',
      '3,Thirdish,thir1234,thi,i,Niger-Congo,nige1235',
      '3,Thirdish,thir1234,thi,u,Niger-Congo,nige1235',
    ].join('\n');

    await withTempCsv(body, async (path) => {
      const out = await loadInventoriesFromPhoible(path);
      expect(out).toHaveLength(3);
      const tiny = out.find((r) => r.language === 'Tinyish');
      expect(tiny).toBeDefined();
      expect(tiny!.family).toBe('Indo-European');
      expect(tiny!.phonemes).toEqual(['p', 't', 'k']);

      const third = out.find((r) => r.language === 'Thirdish');
      expect(third!.phonemes).toContain('s');
    });
  });

  it('de-duplicates repeated Phoneme rows within an inventory, preserving first-seen order', async () => {
    const body = [
      HEADER,
      '7,Dupland,dupl1234,dup,p,Isolate,isol1234',
      '7,Dupland,dupl1234,dup,t,Isolate,isol1234',
      '7,Dupland,dupl1234,dup,p,Isolate,isol1234',
      '7,Dupland,dupl1234,dup,k,Isolate,isol1234',
      '7,Dupland,dupl1234,dup,t,Isolate,isol1234',
    ].join('\n');

    await withTempCsv(body, async (path) => {
      const out = await loadInventoriesFromPhoible(path);
      expect(out).toHaveLength(1);
      expect(out[0].phonemes).toEqual(['p', 't', 'k']);
    });
  });

  it('falls back to family_id when Family_Name is empty, and to "unknown" when both missing', async () => {
    const body = [
      HEADER,
      '1,A,a1,a,p,,idfam1',
      '2,B,b1,b,p,,',
    ].join('\n');

    await withTempCsv(body, async (path) => {
      const out = await loadInventoriesFromPhoible(path);
      const a = out.find((r) => r.language === 'A')!;
      const b = out.find((r) => r.language === 'B')!;
      expect(a.family).toBe('idfam1');
      expect(b.family).toBe('unknown');
    });
  });

  it('preserves quoted phonemes that contain a comma', async () => {
    const body = [
      HEADER,
      '1,Quoteland,quot1234,quo,"p,weird",Isolate,isol1234',
      '1,Quoteland,quot1234,quo,t,Isolate,isol1234',
    ].join('\n');

    await withTempCsv(body, async (path) => {
      const out = await loadInventoriesFromPhoible(path);
      expect(out).toHaveLength(1);
      expect(out[0].phonemes).toContain('p,weird');
      expect(out[0].phonemes).toContain('t');
    });
  });

  it('throws when required columns are missing', async () => {
    const body = 'foo,bar,baz\n1,2,3\n';
    await withTempCsv(body, async (path) => {
      await expect(loadInventoriesFromPhoible(path)).rejects.toThrow(/InventoryID/);
    });
  });
});

describe('loadPhoibleCorpus', () => {
  it('falls back to the bundled INVENTORIES when no phoible JSON has been generated', () => {
    // In the test environment the gitignored inventories.phoible.json is not
    // present, so the lazy accessor should return the curated subset.
    const corpus = loadPhoibleCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(INVENTORIES.length);
    // Identity-equality is fine: the fallback returns the bundled array as-is.
    expect(corpus === INVENTORIES || corpus.length === INVENTORIES.length).toBe(true);
  });
});

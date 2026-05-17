import { mkdir, readFile, writeFile, rename, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Culture, Material, Ornament } from '../schema-v2.js';

function orderKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = orderKeys(obj[k]);
    return sorted;
  }
  return value;
}

function stringify(obj: unknown): string {
  return JSON.stringify(orderKeys(obj), null, 2) + '\n';
}

async function atomicWrite(target: string, contents: string) {
  const tmp = target + '.tmp';
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, target);
}

export async function writeCulture(rootDir: string, culture: Culture): Promise<void> {
  const dir = join(rootDir, culture.id);
  await mkdir(dir, { recursive: true });
  const structural = {
    ...culture,
    materials: culture.materials.map(m => ({ id: m.id, name: m.name })),
    ornaments: culture.ornaments.map(o => ({ id: o.id, name: o.name })),
  };
  await Promise.all([
    atomicWrite(join(dir, 'culture.json'), stringify(structural)),
    atomicWrite(join(dir, 'materials.json'), stringify({ materials: culture.materials })),
    atomicWrite(join(dir, 'ornaments.json'), stringify({ ornaments: culture.ornaments })),
  ]);
}

export async function readCulture(rootDir: string, id: string): Promise<Culture> {
  const dir = join(rootDir, id);
  const [s, m, o] = await Promise.all([
    readFile(join(dir, 'culture.json'), 'utf8').then(t => JSON.parse(t)),
    readFile(join(dir, 'materials.json'), 'utf8').then(t => JSON.parse(t) as { materials: Material[] }),
    readFile(join(dir, 'ornaments.json'), 'utf8').then(t => JSON.parse(t) as { ornaments: Ornament[] }),
  ]);
  return { ...s, materials: m.materials, ornaments: o.ornaments } as Culture;
}

export async function listCultures(rootDir: string): Promise<{ id: string; name: string; eraCount: number }[]> {
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return [];
  }
  const out: { id: string; name: string; eraCount: number }[] = [];
  for (const id of entries) {
    const culturePath = join(rootDir, id, 'culture.json');
    try {
      const st = await stat(culturePath);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(await readFile(culturePath, 'utf8'));
      out.push({ id: parsed.id ?? id, name: parsed.name ?? id, eraCount: Array.isArray(parsed.eras) ? parsed.eras.length : 0 });
    } catch {
      // skip malformed
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function deleteCulture(rootDir: string, id: string): Promise<void> {
  await rm(join(rootDir, id), { recursive: true, force: true });
}

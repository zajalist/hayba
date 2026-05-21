# MCP Tool Routing (γ Hybrid) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Hayba MCP's session-start tool footprint from ~150 typed tools to 6 meta-tools plus on-demand loaded packs, with hybrid BM25+embedding tool search and a polymorphic invoke escape hatch.

**Architecture:** New `src/tools/routing/` module with `PackRegistry` (domain packs auto-derived from dirs + workflow packs from `packs.yaml`), `ToolIndex` (BM25 via `minisearch` + embeddings via Ollama with `@huggingface/transformers` fallback), and a `settings-watcher` reading `Saved/HaybaMCP/settings.json`. `src/tools/index.ts` branches on `toolRouting: "deferred" | "full"`. `hayba_pack_load` mutates the live MCP tool list and fires `notifications/tools/list_changed`.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, vitest, zod, `minisearch`, `js-yaml`, Ollama HTTP API, `@huggingface/transformers` (already a dep).

**Spec:** `docs/superpowers/specs/2026-05-20-mcp-tool-routing-design.md`

---

### Task 1: Dependencies and routing directory skeleton

**Files:**
- Modify: `mcp-tools/hayba-mcp/package.json`
- Create: `mcp-tools/hayba-mcp/src/tools/routing/README.md`

- [ ] **Step 1: Add deps**

Run from repo root:
```bash
cd mcp-tools/hayba-mcp && npm install --save minisearch@^7.1.0 js-yaml@^4.1.0 && npm install --save-dev @types/js-yaml@^4.0.9
```

Expected: `package.json` gains `minisearch`, `js-yaml`, `@types/js-yaml`. No type errors.

- [ ] **Step 2: Create routing/ skeleton**

```bash
mkdir -p mcp-tools/hayba-mcp/src/tools/routing/meta-tools
```

Write `mcp-tools/hayba-mcp/src/tools/routing/README.md`:

```markdown
# Tool Routing (γ Hybrid)

See `docs/superpowers/specs/2026-05-20-mcp-tool-routing-design.md`.

- `settings-watcher.ts` — reads `Saved/HaybaMCP/settings.json`.
- `pack-registry.ts` — domain + workflow packs, load/unload, listChanged.
- `tool-index.ts` — BM25 + embedding hybrid index.
- `meta-tools/` — the 6 always-on tools.
- `packs.yaml` — curated workflow packs.
```

- [ ] **Step 3: Verify build**

Run: `cd mcp-tools/hayba-mcp && npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd D:/Hackathons/hayba
git add mcp-tools/hayba-mcp/package.json mcp-tools/hayba-mcp/package-lock.json mcp-tools/hayba-mcp/src/tools/routing/README.md
git commit -m "chore(mcp): scaffold routing module + add minisearch/js-yaml"
```

---

### Task 2: Settings watcher

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/routing/settings-watcher.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/routing/settings-watcher.test.ts`

- [ ] **Step 1: Write the failing test**

`settings-watcher.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, __resetSettingsCache } from './settings-watcher.js';

describe('settings-watcher', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hayba-settings-'));
    process.env.HAYBA_SETTINGS_PATH = join(dir, 'settings.json');
    __resetSettingsCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HAYBA_SETTINGS_PATH;
  });

  it('returns defaults when file is missing', () => {
    expect(readSettings()).toEqual({ toolRouting: 'deferred', alwaysLoadPacks: [] });
  });

  it('reads valid JSON', () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, JSON.stringify({
      toolRouting: 'full', alwaysLoadPacks: ['biome'],
    }));
    expect(readSettings()).toEqual({ toolRouting: 'full', alwaysLoadPacks: ['biome'] });
  });

  it('falls back to defaults on malformed JSON', () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, '{not json');
    expect(readSettings()).toEqual({ toolRouting: 'deferred', alwaysLoadPacks: [] });
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/settings-watcher.test.ts`
Expected: FAIL with "Cannot find module './settings-watcher.js'".

- [ ] **Step 3: Implement**

`settings-watcher.ts`:
```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ToolRoutingMode = 'deferred' | 'full';
export interface HaybaSettings {
  toolRouting: ToolRoutingMode;
  alwaysLoadPacks: string[];
}

const DEFAULT: HaybaSettings = { toolRouting: 'deferred', alwaysLoadPacks: [] };

function settingsPath(): string {
  return process.env.HAYBA_SETTINGS_PATH
    ?? resolve(process.cwd(), 'Saved/HaybaMCP/settings.json');
}

let cached: HaybaSettings | null = null;

export function readSettings(): HaybaSettings {
  if (cached) return cached;
  try {
    const raw = readFileSync(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<HaybaSettings>;
    cached = {
      toolRouting: parsed.toolRouting === 'full' ? 'full' : 'deferred',
      alwaysLoadPacks: Array.isArray(parsed.alwaysLoadPacks) ? parsed.alwaysLoadPacks : [],
    };
  } catch {
    cached = DEFAULT;
  }
  return cached;
}

export function __resetSettingsCache(): void { cached = null; }
```

- [ ] **Step 4: Verify pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/settings-watcher.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/routing/settings-watcher.ts mcp-tools/hayba-mcp/src/tools/routing/settings-watcher.test.ts
git commit -m "feat(mcp-routing): settings watcher for toolRouting + alwaysLoadPacks"
```

---

### Task 3: Extend HaybaToolMeta with optional `pack` field

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/hayba-tool-meta.ts`

- [ ] **Step 1: Add `pack` to the interface**

Replace contents of `hayba-tool-meta.ts`:
```ts
export type HaybaToolCost = 'low' | 'medium' | 'high';

export interface HaybaToolMeta {
  cost: HaybaToolCost;
  effects: string[];
  when: string;
  not_when: string;
  /**
   * Optional domain pack assignment for tools NOT organized into a subdirectory
   * of src/tools/. Tools in subdirs derive their pack from the directory name.
   * Unset for root-level tools = joins the `core` default pack with a warning.
   */
  pack?: string;
}

export function describeMeta(m: HaybaToolMeta): string {
  return [
    `[cost=${m.cost}]`,
    `[effects=[${m.effects.join(',')}]]`,
    `USE_WHEN: ${m.when}`,
    `NOT_WHEN: ${m.not_when}`,
  ].join(' ');
}

export function appendMeta(description: string, meta: HaybaToolMeta): string {
  return `${description}\n\n${describeMeta(meta)}`;
}
```

- [ ] **Step 2: Verify typecheck still passes**

Run: `cd mcp-tools/hayba-mcp && npm run typecheck`
Expected: 0 errors (the field is optional; nothing else needs updating yet).

- [ ] **Step 3: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/hayba-tool-meta.ts
git commit -m "feat(mcp-routing): add optional pack field to HaybaToolMeta"
```

---

### Task 4: PackRegistry — model + listChanged hook

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/routing/pack-registry.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/routing/pack-registry.test.ts`

- [ ] **Step 1: Write the failing test**

`pack-registry.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PackRegistry, type PackDef } from './pack-registry.js';

const fixture: PackDef[] = [
  { name: 'actor',  kind: 'domain',   description: 'd', tools: ['actor_spawn', 'actor_list'] },
  { name: 'biome',  kind: 'workflow', description: 'd', tools: ['actor_spawn', 'create_pcg_graph'] },
  { name: 'editor', kind: 'workflow', description: 'd', tools: ['editor_capture_viewport'], autoLoadOn: 'ue_connected' },
];

describe('PackRegistry', () => {
  let reg: PackRegistry;
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
    reg = new PackRegistry(fixture, onChange);
  });

  it('lists packs with loaded flag false initially', () => {
    const list = reg.listPacks();
    expect(list.find(p => p.name === 'actor')?.loaded).toBe(false);
  });

  it('loadPack returns added tools and fires onChange', async () => {
    const r = await reg.loadPack('biome');
    expect(r.ok).toBe(true);
    expect(r.addedTools.sort()).toEqual(['actor_spawn', 'create_pcg_graph']);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('loadPack is idempotent (no double-add)', async () => {
    await reg.loadPack('biome');
    const r2 = await reg.loadPack('biome');
    expect(r2.addedTools).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('loadPack on unknown pack returns ok:false + available list', async () => {
    const r = await reg.loadPack('nope');
    expect(r.ok).toBe(false);
    expect(r.available).toContain('biome');
  });

  it('maybeAutoLoad("ue_connected") loads editor pack', async () => {
    await reg.maybeAutoLoad('ue_connected');
    expect(reg.isLoaded('editor')).toBe(true);
  });

  it('loadedTools returns union of loaded packs', async () => {
    await reg.loadPack('biome');
    await reg.loadPack('actor');
    expect(reg.loadedTools().sort()).toEqual(['actor_list', 'actor_spawn', 'create_pcg_graph']);
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/pack-registry.test.ts`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Implement**

`pack-registry.ts`:
```ts
export type PackKind = 'domain' | 'workflow';
export type AutoLoadTrigger = 'ue_connected';

export interface PackDef {
  name: string;
  kind: PackKind;
  description: string;
  tools: string[];
  autoLoadOn?: AutoLoadTrigger;
}

export interface PackListEntry extends PackDef {
  loaded: boolean;
  toolCount: number;
}

export type LoadResult =
  | { ok: true; addedTools: string[] }
  | { ok: false; reason: 'unknown_pack'; available: string[] };

export type OnPacksChanged = () => void | Promise<void>;

export class PackRegistry {
  private packs = new Map<string, PackDef>();
  private loaded = new Set<string>();
  private locks = new Map<string, Promise<void>>();

  constructor(packs: PackDef[], private onChange: OnPacksChanged) {
    for (const p of packs) this.packs.set(p.name, p);
  }

  listPacks(): PackListEntry[] {
    return Array.from(this.packs.values()).map(p => ({
      ...p,
      loaded: this.loaded.has(p.name),
      toolCount: p.tools.length,
    }));
  }

  isLoaded(name: string): boolean { return this.loaded.has(name); }

  loadedTools(): string[] {
    const set = new Set<string>();
    for (const name of this.loaded) {
      for (const t of this.packs.get(name)?.tools ?? []) set.add(t);
    }
    return Array.from(set);
  }

  async loadPack(name: string): Promise<LoadResult> {
    const p = this.packs.get(name);
    if (!p) return { ok: false, reason: 'unknown_pack', available: Array.from(this.packs.keys()) };

    const existing = this.locks.get(name);
    if (existing) { await existing; }
    if (this.loaded.has(name)) return { ok: true, addedTools: [] };

    const before = new Set(this.loadedTools());
    let release!: () => void;
    const lock = new Promise<void>(res => { release = res; });
    this.locks.set(name, lock);
    try {
      this.loaded.add(name);
      const added = p.tools.filter(t => !before.has(t));
      await this.onChange();
      return { ok: true, addedTools: added };
    } finally {
      this.locks.delete(name);
      release();
    }
  }

  async unloadPack(name: string): Promise<void> {
    if (!this.loaded.delete(name)) return;
    await this.onChange();
  }

  async maybeAutoLoad(trigger: AutoLoadTrigger): Promise<void> {
    for (const p of this.packs.values()) {
      if (p.autoLoadOn === trigger && !this.loaded.has(p.name)) {
        await this.loadPack(p.name);
      }
    }
  }
}
```

- [ ] **Step 4: Verify pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/pack-registry.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/routing/pack-registry.ts mcp-tools/hayba-mcp/src/tools/routing/pack-registry.test.ts
git commit -m "feat(mcp-routing): PackRegistry with load/unload, autoLoad, listChanged hook"
```

---

### Task 5: Pack discovery (directory scan + YAML loader)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/routing/pack-discovery.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/routing/packs.yaml`
- Test: `mcp-tools/hayba-mcp/src/tools/routing/pack-discovery.test.ts`

- [ ] **Step 1: Author `packs.yaml`**

```yaml
packs:
  - name: biome
    kind: workflow
    description: Generate dense ecological PCG biomes from intent.
    tools:
      - create_pcg_graph
      - validate_pcg_graph
      - execute_pcg_graph
      - export_pcg_graph
      - list_pcg_assets
      - search_node_catalog
      - get_node_details
      - hayba_polyhaven_search
      - hayba_polyhaven_download
      - hayba_ambientcg_search
      - hayba_ambientcg_download
      - architecture_resolve_rules
      - actor_spawn

  - name: planet-sim
    kind: workflow
    description: Planet-scale physics (tectonics, climate, habitability, tidal locking).
    tools:
      - hayba_planet_dynamo_field
      - hayba_planet_escape_regime
      - hayba_planet_habitable_zone
      - hayba_planet_stability_schema
      - hayba_planet_tidal_locking

  - name: architecture
    kind: workflow
    description: Author cultural architecture rule sets and resolve them.
    tools:
      - architecture_list_cultures
      - architecture_get_culture
      - architecture_resolve_rules
      - architecture_validate_culture
      - architecture_create_culture
      - architecture_update_culture
      - architecture_add_era
      - architecture_add_material
      - architecture_add_ornament
      - architecture_add_tag_axis
      - architecture_add_rule

  - name: connectors
    kind: workflow
    description: All third-party asset connector tools.
    tools:
      - hayba_polyhaven_search
      - hayba_polyhaven_download
      - hayba_ambientcg_search
      - hayba_ambientcg_download
      - hayba_sketchfab_search
      - hayba_sketchfab_download
      - hayba_fab_login_status
      - hayba_fab_library_list
      - hayba_fab_marketplace_search
      - hayba_fab_download

  - name: editor
    kind: workflow
    description: Live UE editor introspection and PIE control.
    autoLoadOn: ue_connected
    tools:
      - editor_capture_viewport
      - editor_stream_log
      - editor_start_pie
      - wait_for_shaders

  - name: python
    kind: workflow
    description: Run arbitrary Python in the UE editor. Powerful; load explicitly.
    tools:
      - python_run
```

- [ ] **Step 2: Write the failing test**

`pack-discovery.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { deriveDomainPacks, loadWorkflowPacks } from './pack-discovery.js';
import { resolve } from 'node:path';

describe('pack-discovery', () => {
  it('derives domain packs from tool->dir mapping', () => {
    const toolDirs = new Map([
      ['actor_spawn', 'actor'],
      ['actor_list',  'actor'],
      ['scene_export', 'scene'],
      ['create_pcg_graph', null],            // root-level, no explicit pack
      ['hayba_planet_dynamo_field', null],   // root-level
    ]);
    const explicitPacks = new Map([
      ['hayba_planet_dynamo_field', 'planet'],
    ]);
    const packs = deriveDomainPacks(toolDirs, explicitPacks);
    expect(packs.find(p => p.name === 'actor')?.tools.sort()).toEqual(['actor_list', 'actor_spawn']);
    expect(packs.find(p => p.name === 'scene')?.tools).toEqual(['scene_export']);
    expect(packs.find(p => p.name === 'planet')?.tools).toEqual(['hayba_planet_dynamo_field']);
    expect(packs.find(p => p.name === 'core')?.tools).toEqual(['create_pcg_graph']);
  });

  it('loads workflow packs from yaml', () => {
    const packs = loadWorkflowPacks(resolve(__dirname, 'packs.yaml'));
    expect(packs.find(p => p.name === 'biome')?.kind).toBe('workflow');
    expect(packs.find(p => p.name === 'editor')?.autoLoadOn).toBe('ue_connected');
  });
});
```

- [ ] **Step 3: Confirm failure**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/pack-discovery.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

`pack-discovery.ts`:
```ts
import { readFileSync } from 'node:fs';
import * as YAML from 'js-yaml';
import type { PackDef } from './pack-registry.js';

export function deriveDomainPacks(
  toolDirs: Map<string, string | null>,
  explicitPacks: Map<string, string>,
): PackDef[] {
  const grouped = new Map<string, string[]>();
  for (const [tool, dir] of toolDirs) {
    const explicit = explicitPacks.get(tool);
    const packName = explicit ?? dir ?? 'core';
    const arr = grouped.get(packName) ?? [];
    arr.push(tool);
    grouped.set(packName, arr);
  }
  return Array.from(grouped.entries()).map(([name, tools]) => ({
    name,
    kind: 'domain' as const,
    description: `Domain pack — tools from ${name === 'core' ? 'root src/tools/' : `src/tools/${name}/`}.`,
    tools: tools.sort(),
  }));
}

interface WorkflowPacksFile {
  packs: Array<{
    name: string;
    kind: 'workflow';
    description: string;
    tools: string[];
    autoLoadOn?: 'ue_connected';
  }>;
}

export function loadWorkflowPacks(yamlPath: string): PackDef[] {
  const raw = readFileSync(yamlPath, 'utf-8');
  const parsed = YAML.load(raw) as WorkflowPacksFile;
  return parsed.packs.map(p => ({
    name: p.name,
    kind: 'workflow' as const,
    description: p.description,
    tools: p.tools,
    autoLoadOn: p.autoLoadOn,
  }));
}
```

Note: tests reference `__dirname` (CommonJS). Add the ESM equivalent at top of `pack-discovery.test.ts`:
```ts
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
```

- [ ] **Step 5: Verify pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/pack-discovery.test.ts`
Expected: 2 passing.

- [ ] **Step 6: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/routing/pack-discovery.ts mcp-tools/hayba-mcp/src/tools/routing/pack-discovery.test.ts mcp-tools/hayba-mcp/src/tools/routing/packs.yaml
git commit -m "feat(mcp-routing): pack discovery — domain (dir scan) + workflow (yaml)"
```

---

### Task 6: ToolIndex — BM25 layer

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/routing/tool-index.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/routing/tool-index.test.ts`

- [ ] **Step 1: Write failing test (BM25 only — embeddings backend mocked to null)**

`tool-index.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ToolIndex, type ToolDoc } from './tool-index.js';

const docs: ToolDoc[] = [
  { name: 'actor_spawn', summary: 'Spawn an actor', description: 'Spawn an actor in the UE level', tags: ['ue', 'editor'], packs: ['actor', 'biome'], cost: 'low' },
  { name: 'create_pcg_graph', summary: 'Create a PCG graph', description: 'Create a procedural content generation graph', tags: ['pcg'], packs: ['biome'], cost: 'medium' },
  { name: 'hayba_planet_dynamo_field', summary: 'Compute dynamo field', description: 'Planetary magnetic dynamo field strength', tags: ['planet', 'physics'], packs: ['planet'], cost: 'high' },
];

describe('ToolIndex BM25', () => {
  it('ranks exact-token matches first', async () => {
    const idx = await ToolIndex.build(docs, { embeddings: null });
    const hits = idx.search('spawn actor', { k: 3 });
    expect(hits[0].name).toBe('actor_spawn');
  });

  it('returns empty array on no hits', async () => {
    const idx = await ToolIndex.build(docs, { embeddings: null });
    const hits = idx.search('zzzzzzz nomatch', { k: 3 });
    expect(hits).toEqual([]);
  });

  it('filterPack restricts results', async () => {
    const idx = await ToolIndex.build(docs, { embeddings: null });
    const hits = idx.search('graph', { k: 5, filterPack: 'planet' });
    expect(hits.find(h => h.name === 'create_pcg_graph')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/tool-index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement BM25 layer**

`tool-index.ts`:
```ts
import MiniSearch from 'minisearch';

export interface ToolDoc {
  name: string;
  summary: string;
  description: string;
  tags: string[];
  packs: string[];
  cost: 'low' | 'medium' | 'high';
}

export interface SearchHit {
  name: string;
  summary: string;
  packs: string[];
  score: number;
}

export interface SearchOpts {
  k?: number;
  filterPack?: string;
}

export interface EmbeddingBackend {
  embed(texts: string[]): Promise<Float32Array[]>;
  id: string;
}

export interface BuildOpts {
  embeddings: EmbeddingBackend | null;
}

export class ToolIndex {
  private constructor(
    private bm25: MiniSearch<ToolDoc>,
    private docs: Map<string, ToolDoc>,
    private vectors: Map<string, Float32Array> | null,
  ) {}

  static async build(docs: ToolDoc[], opts: BuildOpts): Promise<ToolIndex> {
    const bm25 = new MiniSearch<ToolDoc>({
      fields: ['name', 'summary', 'description', 'tags'],
      storeFields: ['name', 'summary', 'packs'],
      idField: 'name',
      extractField: (d, f) => {
        const v = (d as Record<string, unknown>)[f];
        return Array.isArray(v) ? v.join(' ') : String(v ?? '');
      },
    });
    bm25.addAll(docs);

    let vectors: Map<string, Float32Array> | null = null;
    if (opts.embeddings) {
      vectors = new Map();
      const texts = docs.map(d => `${d.name}. ${d.summary}. ${d.description}. tags: ${d.tags.join(', ')}`);
      const embedded = await opts.embeddings.embed(texts);
      docs.forEach((d, i) => vectors!.set(d.name, embedded[i]));
    }

    return new ToolIndex(bm25, new Map(docs.map(d => [d.name, d])), vectors);
  }

  search(query: string, opts: SearchOpts = {}): SearchHit[] {
    const k = opts.k ?? 8;
    const raw = this.bm25.search(query, { prefix: true, fuzzy: 0.2 });
    const hits: SearchHit[] = raw
      .map(r => {
        const d = this.docs.get(r.id as string)!;
        return { name: d.name, summary: d.summary, packs: d.packs, score: r.score };
      })
      .filter(h => !opts.filterPack || h.packs.includes(opts.filterPack))
      .slice(0, k);
    return hits;
  }
}
```

- [ ] **Step 4: Verify pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/tool-index.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/routing/tool-index.ts mcp-tools/hayba-mcp/src/tools/routing/tool-index.test.ts
git commit -m "feat(mcp-routing): ToolIndex BM25 layer (embeddings stubbed)"
```

---

### Task 7: ToolIndex — embedding backends + hybrid ranking

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/routing/embedding-backends.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/routing/tool-index.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/routing/tool-index.test.ts`

- [ ] **Step 1: Write failing test for hybrid ranking**

Add to `tool-index.test.ts`:
```ts
import { describe as desc2 } from 'vitest';

class FakeEmbeddings {
  id = 'fake';
  async embed(texts: string[]): Promise<Float32Array[]> {
    // Hand-crafted: text containing "planet" → vector close to [1,0,0]
    return texts.map(t => {
      if (/planet|dynamo/i.test(t)) return new Float32Array([1, 0, 0]);
      if (/pcg|graph/i.test(t))     return new Float32Array([0, 1, 0]);
      return new Float32Array([0, 0, 1]);
    });
  }
}

desc2('ToolIndex hybrid', () => {
  it('embedding hit boosts a term BM25 misses', async () => {
    const idx = await ToolIndex.build(docs, { embeddings: new FakeEmbeddings() });
    // "magnetic" appears in description but not name/summary tokens — BM25
    // alone may rank weakly; embedding should rescue it.
    const hits = idx.search('magnetic field generation', { k: 3 });
    expect(hits.some(h => h.name === 'hayba_planet_dynamo_field')).toBe(true);
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/tool-index.test.ts`
Expected: hybrid test fails (BM25 alone doesn't include `dynamo_field` for query "magnetic field generation").

- [ ] **Step 3: Implement embedding backends**

`embedding-backends.ts`:
```ts
import type { EmbeddingBackend } from './tool-index.js';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.HAYBA_EMBED_MODEL_OLLAMA ?? 'nomic-embed-text';
const XENOVA_MODEL = process.env.HAYBA_EMBED_MODEL_XENOVA ?? 'Xenova/all-MiniLM-L6-v2';

export async function probeOllama(): Promise<EmbeddingBackend | null> {
  try {
    const probe = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: 'probe' }),
    });
    if (!probe.ok) return null;
    return {
      id: `ollama:${OLLAMA_MODEL}`,
      async embed(texts: string[]): Promise<Float32Array[]> {
        const out: Float32Array[] = [];
        for (const t of texts) {
          const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: OLLAMA_MODEL, prompt: t }),
          });
          if (!r.ok) throw new Error(`ollama embed http ${r.status}`);
          const json = await r.json() as { embedding: number[] };
          out.push(new Float32Array(json.embedding));
        }
        return out;
      },
    };
  } catch { return null; }
}

export async function probeTransformers(): Promise<EmbeddingBackend | null> {
  try {
    const { pipeline } = await import('@huggingface/transformers');
    const pipe = await pipeline('feature-extraction', XENOVA_MODEL);
    return {
      id: `transformers:${XENOVA_MODEL}`,
      async embed(texts: string[]): Promise<Float32Array[]> {
        const out: Float32Array[] = [];
        for (const t of texts) {
          const result = await pipe(t, { pooling: 'mean', normalize: true });
          out.push(new Float32Array(result.data as Float32Array));
        }
        return out;
      },
    };
  } catch { return null; }
}

export async function selectEmbeddingBackend(): Promise<EmbeddingBackend | null> {
  return (await probeOllama()) ?? (await probeTransformers());
}
```

- [ ] **Step 4: Add hybrid scoring to ToolIndex**

Replace the body of `ToolIndex.search` in `tool-index.ts`:
```ts
  search(query: string, opts: SearchOpts = {}): SearchHit[] {
    const k = opts.k ?? 8;
    const bm25Hits = this.bm25.search(query, { prefix: true, fuzzy: 0.2 });
    const bm25Rank = new Map<string, number>();
    bm25Hits.forEach((h, i) => bm25Rank.set(h.id as string, i + 1));

    // Embeddings rank (cosine similarity) — only if vectors available AND we have a query vector
    const embRank = new Map<string, number>();
    if (this.vectors && this.vectors.size > 0) {
      const qv = this.queryVector?.(query);
      if (qv) {
        const scored: Array<[string, number]> = [];
        for (const [name, v] of this.vectors) scored.push([name, cosine(qv, v)]);
        scored.sort((a, b) => b[1] - a[1]);
        scored.forEach(([name], i) => embRank.set(name, i + 1));
      }
    }

    // Reciprocal Rank Fusion (k_rrf = 60)
    const K_RRF = 60;
    const fused = new Map<string, number>();
    const all = new Set<string>([...bm25Rank.keys(), ...embRank.keys()]);
    for (const id of all) {
      const a = bm25Rank.get(id);
      const b = embRank.get(id);
      const score = (a ? 1 / (K_RRF + a) : 0) + (b ? 1 / (K_RRF + b) : 0);
      fused.set(id, score);
    }

    return Array.from(fused.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, score]) => {
        const d = this.docs.get(name)!;
        return { name: d.name, summary: d.summary, packs: d.packs, score };
      })
      .filter(h => !opts.filterPack || h.packs.includes(opts.filterPack))
      .slice(0, k);
  }
```

Also extend the constructor + `build` to accept an optional `embeddings` reference for query-time embedding, and store `queryVector`:
```ts
// in ToolIndex private fields:
  private queryVector?: (q: string) => Float32Array | null;

// in build():
    const idx = new ToolIndex(bm25, new Map(docs.map(d => [d.name, d])), vectors);
    if (opts.embeddings) {
      // cache last query for synchronous-ish access; ToolIndex.search needs sync.
      // Switch search() to async if you'd rather; here we precompute query vec
      // via a synchronous closure by routing queries through embedQuery() async first.
    }
    return idx;
```

NOTE: BM25 is sync; embedding query is async. Simplest path = make `ToolIndex.search` async and have callers `await`. Update signature + tests:
```ts
  async search(query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    // ...
    let qv: Float32Array | null = null;
    if (this.embeddings && this.vectors) qv = (await this.embeddings.embed([query]))[0];
    // ... use qv in place of this.queryVector?.(query) ...
  }
```

Store `private embeddings: EmbeddingBackend | null` on the class via the constructor. Update all tests to `await idx.search(...)`.

Add helper at bottom of `tool-index.ts`:
```ts
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}
```

- [ ] **Step 5: Verify pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/tool-index.test.ts`
Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/routing/embedding-backends.ts mcp-tools/hayba-mcp/src/tools/routing/tool-index.ts mcp-tools/hayba-mcp/src/tools/routing/tool-index.test.ts
git commit -m "feat(mcp-routing): hybrid BM25+embedding search with RRF, Ollama+transformers backends"
```

---

### Task 8: ToolIndex disk cache + hash invalidation

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/routing/tool-index.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/routing/tool-index.test.ts`

- [ ] **Step 1: Write failing test**

Append to `tool-index.test.ts`:
```ts
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('ToolIndex cache', () => {
  it('rebuild only when hash changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hayba-idx-'));
    try {
      const a = await ToolIndex.build(docs, { embeddings: null, cacheDir: dir });
      expect(existsSync(join(dir, 'tool-index.meta.json'))).toBe(true);

      // Build again with identical docs — should load from cache (no exception, results equivalent)
      const b = await ToolIndex.build(docs, { embeddings: null, cacheDir: dir });
      expect((await b.search('spawn')).map(h => h.name)).toEqual(
        (await a.search('spawn')).map(h => h.name),
      );

      // Corrupt cache — should rebuild from scratch, not crash
      writeFileSync(join(dir, 'tool-index.meta.json'), '{not json');
      const c = await ToolIndex.build(docs, { embeddings: null, cacheDir: dir });
      expect((await c.search('spawn'))[0]?.name).toBe('actor_spawn');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/tool-index.test.ts`
Expected: FAIL ("cacheDir not supported").

- [ ] **Step 3: Implement cache**

Add to `tool-index.ts`:
```ts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildOpts {
  embeddings: EmbeddingBackend | null;
  cacheDir?: string;
}

function hashDocs(docs: ToolDoc[]): string {
  const h = createHash('sha256');
  for (const d of [...docs].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(`${d.name} ${d.summary} ${d.description} ${d.tags.join(',')} ${d.packs.join(',')}\n`);
  }
  return h.digest('hex');
}

// Inside ToolIndex.build (top, before constructing):
    if (opts.cacheDir) {
      mkdirSync(opts.cacheDir, { recursive: true });
      const metaPath = join(opts.cacheDir, 'tool-index.meta.json');
      const bm25Path = join(opts.cacheDir, 'tool-index.bm25.json');
      const hash = hashDocs(docs);
      const backendId = opts.embeddings?.id ?? 'none';
      let cached: { hash: string; backendId: string } | null = null;
      try {
        if (existsSync(metaPath)) cached = JSON.parse(readFileSync(metaPath, 'utf-8'));
      } catch { cached = null; }
      if (cached?.hash === hash && cached?.backendId === backendId && existsSync(bm25Path)) {
        try {
          const bm25 = MiniSearch.loadJSON<ToolDoc>(readFileSync(bm25Path, 'utf-8'), {
            fields: ['name', 'summary', 'description', 'tags'],
            storeFields: ['name', 'summary', 'packs'],
            idField: 'name',
          });
          const docMap = new Map(docs.map(d => [d.name, d]));
          return new ToolIndex(bm25, docMap, null, opts.embeddings);
        } catch { /* fall through to rebuild */ }
      }
    }
    // ... existing build logic ...
    // After bm25.addAll(docs):
    if (opts.cacheDir) {
      writeFileSync(join(opts.cacheDir, 'tool-index.bm25.json'), JSON.stringify(bm25));
      writeFileSync(
        join(opts.cacheDir, 'tool-index.meta.json'),
        JSON.stringify({ hash: hashDocs(docs), backendId: opts.embeddings?.id ?? 'none' }),
      );
    }
```

(Embedding vectors are not persisted in v1 — they're cheap to recompute at build time and avoid binary format complexity. Future task can add.)

- [ ] **Step 4: Verify pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/tool-index.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/routing/tool-index.ts mcp-tools/hayba-mcp/src/tools/routing/tool-index.test.ts
git commit -m "feat(mcp-routing): ToolIndex disk cache with hash invalidation"
```

---

### Task 9: Meta-tool — `hayba_search_tools`

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/routing/meta-tools/search-tools.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/routing/meta-tools/search-tools.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolIndex, type ToolDoc } from '../tool-index.js';
import { searchToolsHandler, searchToolsSchema } from './search-tools.js';

const docs: ToolDoc[] = [
  { name: 'actor_spawn', summary: 'Spawn an actor', description: '', tags: [], packs: ['actor'], cost: 'low' },
];

describe('hayba_search_tools', () => {
  it('returns ranked hits', async () => {
    const idx = await ToolIndex.build(docs, { embeddings: null });
    const res = await searchToolsHandler({ query: 'spawn', k: 3 }, { index: idx });
    expect(res.hits[0].name).toBe('actor_spawn');
  });

  it('schema accepts optional filterPack', () => {
    const parsed = z.object(searchToolsSchema).parse({ query: 'x', filterPack: 'biome' });
    expect(parsed.filterPack).toBe('biome');
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/meta-tools/search-tools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { z } from 'zod';
import type { ToolIndex, SearchHit } from '../tool-index.js';

export const searchToolsSchema = {
  query: z.string().min(1),
  k: z.number().int().min(1).max(20).optional(),
  filterPack: z.string().optional(),
};

export interface SearchToolsCtx { index: ToolIndex; }
export interface SearchToolsResult { hits: SearchHit[]; }

export async function searchToolsHandler(
  args: { query: string; k?: number; filterPack?: string },
  ctx: SearchToolsCtx,
): Promise<SearchToolsResult> {
  const hits = await ctx.index.search(args.query, { k: args.k ?? 8, filterPack: args.filterPack });
  return { hits };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You need to find a tool by capability before loading a pack or invoking.',
  not_when: 'You already know the exact tool name — call hayba_get_tool_signature instead.',
  pack: 'core',
};
```

- [ ] **Step 4: Verify pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/meta-tools/search-tools.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/routing/meta-tools/search-tools.ts mcp-tools/hayba-mcp/src/tools/routing/meta-tools/search-tools.test.ts
git commit -m "feat(mcp-routing): hayba_search_tools meta-tool"
```

---

### Task 10: Meta-tools — `hayba_pack_list` + `hayba_pack_load`

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/routing/meta-tools/pack-list.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/routing/meta-tools/pack-load.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/routing/meta-tools/pack-tools.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { PackRegistry, type PackDef } from '../pack-registry.js';
import { packListHandler } from './pack-list.js';
import { packLoadHandler } from './pack-load.js';

const fixture: PackDef[] = [
  { name: 'biome', kind: 'workflow', description: 'b', tools: ['create_pcg_graph'] },
];

describe('pack meta-tools', () => {
  it('pack_list returns loaded flag and toolCount', async () => {
    const reg = new PackRegistry(fixture, vi.fn());
    const res = await packListHandler({}, { registry: reg });
    expect(res.packs[0]).toMatchObject({ name: 'biome', loaded: false, toolCount: 1 });
  });

  it('pack_load happy path returns addedTools', async () => {
    const reg = new PackRegistry(fixture, vi.fn());
    const res = await packLoadHandler({ name: 'biome' }, { registry: reg });
    expect(res).toEqual({ ok: true, addedTools: ['create_pcg_graph'] });
  });

  it('pack_load unknown returns ok:false with available list', async () => {
    const reg = new PackRegistry(fixture, vi.fn());
    const res = await packLoadHandler({ name: 'nope' }, { registry: reg });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.available).toEqual(['biome']);
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/meta-tools/pack-tools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`pack-list.ts`:
```ts
import { z } from 'zod';
import type { PackRegistry, PackListEntry } from '../pack-registry.js';

export const packListSchema = {};
export interface PackListCtx { registry: PackRegistry; }
export interface PackListResult { packs: PackListEntry[]; }

export async function packListHandler(_args: {}, ctx: PackListCtx): Promise<PackListResult> {
  return { packs: ctx.registry.listPacks() };
}

export const meta = {
  cost: 'low' as const, effects: ['read'],
  when: 'You want to discover what tool packs exist before loading one.',
  not_when: 'You already know the pack name — call hayba_pack_load directly.',
  pack: 'core',
};
```

`pack-load.ts`:
```ts
import { z } from 'zod';
import type { PackRegistry, LoadResult } from '../pack-registry.js';

export const packLoadSchema = { name: z.string().min(1) };
export interface PackLoadCtx { registry: PackRegistry; }

export async function packLoadHandler(args: { name: string }, ctx: PackLoadCtx): Promise<LoadResult> {
  return ctx.registry.loadPack(args.name);
}

export const meta = {
  cost: 'low' as const, effects: ['mutate_tool_list'],
  when: 'You searched and the matching tool lives in a pack that is not loaded.',
  not_when: 'A single one-off call — use hayba_invoke instead to avoid pack thrash.',
  pack: 'core',
};
```

- [ ] **Step 4: Verify pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/meta-tools/pack-tools.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/routing/meta-tools/pack-list.ts mcp-tools/hayba-mcp/src/tools/routing/meta-tools/pack-load.ts mcp-tools/hayba-mcp/src/tools/routing/meta-tools/pack-tools.test.ts
git commit -m "feat(mcp-routing): hayba_pack_list + hayba_pack_load meta-tools"
```

---

### Task 11: Meta-tool — `hayba_invoke`

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/routing/meta-tools/invoke.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/routing/meta-tools/invoke.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { recordSchema } from '../../schema-registry.js';
import { invokeHandler } from './invoke.js';

describe('hayba_invoke', () => {
  it('validates args via recorded zod schema', async () => {
    recordSchema('echo_tool', { shape: { msg: z.string() }, cost: 'low', returns: 'string' });
    const fakeDispatch = vi.fn(async (cmd: string, args: Record<string, unknown>) => ({ echoed: args.msg }));
    const res = await invokeHandler({ name: 'echo_tool', args: { msg: 'hi' } }, {
      dispatch: fakeDispatch, isDisabled: () => false,
    });
    expect(res).toEqual({ ok: true, result: { echoed: 'hi' } });
    expect(fakeDispatch).toHaveBeenCalledWith('echo_tool', { msg: 'hi' });
  });

  it('returns validation error on bad args', async () => {
    recordSchema('echo_tool', { shape: { msg: z.string() }, cost: 'low', returns: 'string' });
    const res = await invokeHandler({ name: 'echo_tool', args: { msg: 123 } }, {
      dispatch: vi.fn(), isDisabled: () => false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('validation');
  });

  it('refuses disabled tools', async () => {
    recordSchema('echo_tool', { shape: { msg: z.string() }, cost: 'low', returns: 'string' });
    const res = await invokeHandler({ name: 'echo_tool', args: { msg: 'hi' } }, {
      dispatch: vi.fn(), isDisabled: () => true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('tool_disabled');
  });

  it('returns unknown_tool when no schema recorded', async () => {
    const res = await invokeHandler({ name: 'nonexistent', args: {} }, {
      dispatch: vi.fn(), isDisabled: () => false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('unknown_tool');
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/meta-tools/invoke.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { z, type ZodRawShape } from 'zod';

// Local access to schema-registry’s internal map via a small read helper.
// We can't introspect the existing REGISTRY directly without exporting; add
// a getRawShape helper to schema-registry first if it doesn't exist.
import { getRawShape } from '../../schema-registry.js';

export const invokeSchema = {
  name: z.string().min(1),
  args: z.record(z.unknown()).default({}),
};

export type InvokeResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { kind: 'validation'; issues: unknown } }
  | { ok: false; error: { kind: 'tool_disabled'; name: string } }
  | { ok: false; error: { kind: 'unknown_tool'; name: string } };

export interface InvokeCtx {
  dispatch: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  isDisabled: (name: string) => boolean;
}

export async function invokeHandler(
  args: { name: string; args: Record<string, unknown> },
  ctx: InvokeCtx,
): Promise<InvokeResult> {
  if (ctx.isDisabled(args.name)) {
    return { ok: false, error: { kind: 'tool_disabled', name: args.name } };
  }
  const shape: ZodRawShape | null = getRawShape(args.name);
  if (!shape) {
    return { ok: false, error: { kind: 'unknown_tool', name: args.name } };
  }
  const parse = z.object(shape).safeParse(args.args);
  if (!parse.success) {
    return { ok: false, error: { kind: 'validation', issues: parse.error.issues } };
  }
  const result = await ctx.dispatch(args.name, parse.data as Record<string, unknown>);
  return { ok: true, result };
}

export const meta = {
  cost: 'medium' as const, effects: ['variable'],
  when: 'You need to call a tool that exists in an unloaded pack as a one-off.',
  not_when: 'You will call this tool repeatedly — load its pack instead.',
  pack: 'core',
};
```

- [ ] **Step 4: Add `getRawShape` helper to `schema-registry.ts`**

Append to `mcp-tools/hayba-mcp/src/tools/schema-registry.ts`:
```ts
export function getRawShape(name: string): ZodRawShape | null {
  return REGISTRY.get(name)?.shape ?? null;
}
```

- [ ] **Step 5: Verify pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/routing/meta-tools/invoke.test.ts`
Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/routing/meta-tools/invoke.ts mcp-tools/hayba-mcp/src/tools/routing/meta-tools/invoke.test.ts mcp-tools/hayba-mcp/src/tools/schema-registry.ts
git commit -m "feat(mcp-routing): hayba_invoke polymorphic dispatcher with validation"
```

---

### Task 12: Wire `check_ue_status` autoload trigger

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/check-ue-status.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/check-ue-status.test.ts`

- [ ] **Step 1: Inspect existing test to follow style**

Run: `cat D:/Hackathons/hayba/mcp-tools/hayba-mcp/src/tools/check-ue-status.test.ts`. Mirror its structure.

- [ ] **Step 2: Add failing test**

Append to `check-ue-status.test.ts`:
```ts
import { vi } from 'vitest';

it('triggers PackRegistry.maybeAutoLoad on first success', async () => {
  const maybeAutoLoad = vi.fn(async () => {});
  // call the handler with a fake successful sender and an injected registry
  // — adjust to match the handler signature; if the handler doesn't take a
  // registry yet, this drives the modification in the next step.
  // ... (write the assertion that calls handler twice and expects
  //      maybeAutoLoad to be called exactly once with 'ue_connected')
});
```

- [ ] **Step 3: Confirm failure, then refactor handler to accept optional registry**

In `check-ue-status.ts`, expose an `onConnected` callback option (default no-op), and call it on first successful poll. The integration wiring in Task 14 will inject `() => registry.maybeAutoLoad('ue_connected')`.

```ts
// Add module-level latch:
let connectedLatch = false;
export function __resetConnectedLatch() { connectedLatch = false; }

// In handler, after a successful response:
if (!connectedLatch) {
  connectedLatch = true;
  await opts?.onConnected?.();
}
```

- [ ] **Step 4: Verify pass**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/check-ue-status.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/check-ue-status.ts mcp-tools/hayba-mcp/src/tools/check-ue-status.test.ts
git commit -m "feat(mcp-routing): check_ue_status fires onConnected once for autoload"
```

---

### Task 13: Wire routing into `src/tools/index.ts`

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/index.ts`

This task does NOT add new tests; it composes the previously tested pieces. The integration test in Task 14 covers the wiring.

- [ ] **Step 1: Add a thin registration helper**

Create `mcp-tools/hayba-mcp/src/tools/routing/register.ts`:
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readSettings } from './settings-watcher.js';
import { PackRegistry } from './pack-registry.js';
import { ToolIndex, type ToolDoc } from './tool-index.js';
import { selectEmbeddingBackend } from './embedding-backends.js';
import { deriveDomainPacks, loadWorkflowPacks } from './pack-discovery.js';
import { searchToolsHandler, searchToolsSchema, meta as searchMeta } from './meta-tools/search-tools.js';
import { packListHandler, meta as plMeta } from './meta-tools/pack-list.js';
import { packLoadHandler, packLoadSchema, meta as plMeta2 } from './meta-tools/pack-load.js';
import { invokeHandler, invokeSchema, meta as invMeta } from './meta-tools/invoke.js';
import { isToolDisabled } from '../disabled-tools-watcher.js';
import { executeCommand } from '../tool-executor.js';
import { listRecordedCommands } from '../schema-registry.js';
import { getToolMeta } from '../tool-meta-registry.js';
import { appendMeta } from '../hayba-tool-meta.js';
import { resolve } from 'node:path';

export interface RoutingHandle {
  mode: 'deferred' | 'full';
  registry?: PackRegistry;
  index?: ToolIndex;
}

/**
 * Single source of truth for all tool registration once the legacy
 * register-everything path has been collected into `allTools` (an array
 * of {name, dir, schema, handler}).
 */
export interface ToolDescriptor {
  name: string;
  dir: string | null;       // directory under src/tools/ or null for root
  schema: z.ZodRawShape;
  handler: (args: any) => Promise<unknown>;
}

export async function registerRouting(
  server: McpServer,
  allTools: ToolDescriptor[],
  cacheDir: string,
): Promise<RoutingHandle> {
  const settings = readSettings();

  if (settings.toolRouting === 'full') {
    for (const t of allTools) {
      if (isToolDisabled(t.name)) continue;
      server.tool(t.name, t.schema, t.handler);
    }
    return { mode: 'full' };
  }

  // Deferred mode
  const toolDirs = new Map(allTools.map(t => [t.name, t.dir] as const));
  const explicitPacks = new Map<string, string>();
  for (const t of allTools) {
    const m = getToolMeta(t.name);
    if (m?.pack) explicitPacks.set(t.name, m.pack);
  }
  const domainPacks = deriveDomainPacks(toolDirs, explicitPacks);
  const workflowPacks = loadWorkflowPacks(resolve(import.meta.dirname ?? __dirname, 'packs.yaml'));
  const allPacks = [...domainPacks, ...workflowPacks];

  const toolByName = new Map(allTools.map(t => [t.name, t]));
  const registeredNames = new Set<string>();

  const registerByName = (name: string) => {
    if (registeredNames.has(name)) return;
    if (isToolDisabled(name)) return;
    const t = toolByName.get(name);
    if (!t) return;
    server.tool(t.name, t.schema, t.handler);
    registeredNames.add(name);
  };

  const onPacksChanged = async () => {
    for (const name of registry.loadedTools()) registerByName(name);
    // listChanged is emitted automatically by McpServer when registering new tools
  };

  const registry = new PackRegistry(allPacks, onPacksChanged);

  // Build tool index from all tools (loaded or not)
  const embeddings = await selectEmbeddingBackend();
  const docs: ToolDoc[] = allTools.map(t => {
    const m = getToolMeta(t.name);
    const dirPack = t.dir ?? 'core';
    const packs = [m?.pack ?? dirPack, ...workflowPacks.filter(w => w.tools.includes(t.name)).map(w => w.name)];
    return {
      name: t.name,
      summary: m?.when ?? '',
      description: appendMeta('', m ?? { cost: 'medium', effects: [], when: '', not_when: '' }),
      tags: m?.effects ?? [],
      packs: Array.from(new Set(packs)),
      cost: (m?.cost ?? 'medium') as 'low' | 'medium' | 'high',
    };
  });
  const index = await ToolIndex.build(docs, { embeddings, cacheDir });

  // Always-on meta-tools
  server.tool('hayba_search_tools', searchToolsSchema,
    async (a) => searchToolsHandler(a, { index }));
  server.tool('hayba_pack_list', {},
    async () => packListHandler({}, { registry }));
  server.tool('hayba_pack_load', packLoadSchema,
    async (a) => packLoadHandler(a, { registry }));
  server.tool('hayba_invoke', invokeSchema,
    async (a) => invokeHandler(a, {
      dispatch: (cmd, params) => executeCommand(cmd, params),
      isDisabled: isToolDisabled,
    }));

  // Load alwaysLoadPacks now
  for (const name of settings.alwaysLoadPacks) await registry.loadPack(name);

  return { mode: 'deferred', registry, index };
}
```

- [ ] **Step 2: Modify `src/tools/index.ts` to use the descriptor list**

Wrap each existing `server.tool(name, schema, handler)` call so it builds a `ToolDescriptor` instead, then at the end call `registerRouting(server, descriptors, cacheDir)`.

The simplest refactor: keep all the imports, replace the `server.tool(...)` block with `descriptors.push({ name, dir, schema, handler })`. Group by directory using the import path (`./actor/...` → `dir: 'actor'`, root paths → `dir: null`).

After all descriptors are pushed:
```ts
import { registerRouting } from './routing/register.js';
import { resolve } from 'node:path';

const cacheDir = process.env.HAYBA_TOOL_INDEX_DIR
  ?? resolve(process.cwd(), 'Saved/HaybaMCP');
await registerRouting(server, descriptors, cacheDir);
```

Also: invoke `registry.maybeAutoLoad('ue_connected')` from the `onConnected` hook in `check-ue-status.ts` by passing it via the existing registration site.

- [ ] **Step 3: Build and typecheck**

Run: `cd mcp-tools/hayba-mcp && npm run typecheck && npm run build`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/routing/register.ts mcp-tools/hayba-mcp/src/tools/index.ts
git commit -m "feat(mcp-routing): wire registerRouting into tools/index.ts (γ default)"
```

---

### Task 14: Integration test

**Files:**
- Create: `mcp-tools/hayba-mcp/tests/routing-integration.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRouting, type ToolDescriptor } from '../src/tools/routing/register.js';
import { recordSchema } from '../src/tools/schema-registry.js';
import { registerToolMeta } from '../src/tools/tool-meta-registry.js';
import { __resetSettingsCache } from '../src/tools/routing/settings-watcher.js';

function fixtureTools(): ToolDescriptor[] {
  const tools: ToolDescriptor[] = [];
  for (const [name, dir] of [
    ['actor_spawn',      'actor'],
    ['actor_list',       'actor'],
    ['scene_export',     'scene'],
    ['create_pcg_graph', null],
  ] as const) {
    const schema = { foo: z.string().optional() };
    recordSchema(name, { shape: schema, cost: 'low', returns: 'any' });
    registerToolMeta(name, { cost: 'low', effects: [], when: name, not_when: '' });
    tools.push({ name, dir, schema, handler: async () => ({ ok: name }) });
  }
  return tools;
}

describe('routing integration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hayba-int-'));
    process.env.HAYBA_SETTINGS_PATH = join(dir, 'settings.json');
    process.env.HAYBA_TOOL_INDEX_DIR = dir;
    __resetSettingsCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HAYBA_SETTINGS_PATH;
    delete process.env.HAYBA_TOOL_INDEX_DIR;
  });

  it('deferred mode registers only meta-tools at start', async () => {
    const server = new McpServer({ name: 'test', version: '0' });
    const handle = await registerRouting(server, fixtureTools(), dir);
    expect(handle.mode).toBe('deferred');
    // Inspect registered tools via the SDK's internals or via list_tools request:
    const tools = await (server as any)._registeredTools as Map<string, unknown>;
    // The exact field name depends on the SDK version — adjust to match.
    expect(Array.from(tools.keys()).sort()).toEqual(
      ['hayba_invoke', 'hayba_pack_list', 'hayba_pack_load', 'hayba_search_tools'],
    );
  });

  it('pack_load adds typed tools', async () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, JSON.stringify({
      toolRouting: 'deferred', alwaysLoadPacks: ['actor'],
    }));
    const server = new McpServer({ name: 'test', version: '0' });
    const handle = await registerRouting(server, fixtureTools(), dir);
    const tools = await (server as any)._registeredTools as Map<string, unknown>;
    expect(tools.has('actor_spawn')).toBe(true);
    expect(tools.has('actor_list')).toBe(true);
    expect(tools.has('scene_export')).toBe(false);
  });

  it('full mode registers everything, no meta-tools', async () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, JSON.stringify({
      toolRouting: 'full', alwaysLoadPacks: [],
    }));
    const server = new McpServer({ name: 'test', version: '0' });
    const handle = await registerRouting(server, fixtureTools(), dir);
    expect(handle.mode).toBe('full');
    const tools = await (server as any)._registeredTools as Map<string, unknown>;
    expect(tools.has('hayba_search_tools')).toBe(false);
    expect(tools.has('actor_spawn')).toBe(true);
    expect(tools.has('create_pcg_graph')).toBe(true);
  });
});
```

Note: the McpServer internal map access (`_registeredTools`) may be private — if the SDK version doesn't expose it, fall back to constructing a fresh `Client` connected to this server via in-memory transport and calling `listTools()`. Adjust accordingly during implementation.

- [ ] **Step 2: Confirm failure → fix wiring**

Run: `cd mcp-tools/hayba-mcp && npx vitest run tests/routing-integration.test.ts`
Expected: failures will surface any wiring gaps from Task 13. Iterate until green.

- [ ] **Step 3: Run full test suite**

Run: `cd mcp-tools/hayba-mcp && npm test`
Expected: all passing (existing + new).

- [ ] **Step 4: Commit**

```bash
git add mcp-tools/hayba-mcp/tests/routing-integration.test.ts
git commit -m "test(mcp-routing): integration test for deferred + full modes"
```

---

### Task 15: Move `python_run` to `python` pack; verify editor pack autoload

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/python/python-run.ts` (set `pack: 'python'` in its meta) OR confirm it falls into the auto-derived `python` pack from its directory.

- [ ] **Step 1: Check actual placement**

```bash
ls D:/Hackathons/hayba/mcp-tools/hayba-mcp/src/tools/python/
```
If `python_run` already lives in `src/tools/python/`, the directory scan derives a `python` domain pack automatically and no code change is needed beyond removing it from the always-on list (which Task 13 already did by *not* including it).

- [ ] **Step 2: Confirm `editor` workflow pack autoload**

The `editor` workflow pack from `packs.yaml` has `autoLoadOn: ue_connected`. Trace through Task 12's `onConnected` callback to confirm it calls `registry.maybeAutoLoad('ue_connected')`. Add a smoke assertion to the integration test:

Append to `routing-integration.test.ts`:
```ts
it('editor pack auto-loads on ue_connected trigger', async () => {
  const server = new McpServer({ name: 'test', version: '0' });
  // Add fixture editor tools
  recordSchema('editor_capture_viewport', { shape: {}, cost: 'low', returns: 'any' });
  registerToolMeta('editor_capture_viewport', { cost: 'low', effects: [], when: 'x', not_when: '' });
  const tools: ToolDescriptor[] = [{
    name: 'editor_capture_viewport', dir: 'editor', schema: {}, handler: async () => ({}),
  }];
  const handle = await registerRouting(server, tools, dir);
  if (handle.mode !== 'deferred' || !handle.registry) throw new Error('expected deferred');
  await handle.registry.maybeAutoLoad('ue_connected');
  expect(handle.registry.isLoaded('editor')).toBe(true);
});
```

- [ ] **Step 3: Run tests**

Run: `cd mcp-tools/hayba-mcp && npm test`
Expected: all passing.

- [ ] **Step 4: Commit**

```bash
git add mcp-tools/hayba-mcp/tests/routing-integration.test.ts
git commit -m "test(mcp-routing): editor pack auto-loads on ue_connected"
```

---

### Task 16: Update CONTEXT.md and document the migration

**Files:**
- Modify: `mcp-tools/hayba-mcp/CONTEXT.md`

- [ ] **Step 1: Append routing section**

Append to `CONTEXT.md`:
```markdown
## Tool Routing (γ Hybrid, since 2026-05-20)

Hayba MCP defaults to **deferred** tool routing. At session start the server
registers only 6 meta-tools (`hayba_search_tools`, `hayba_pack_list`,
`hayba_pack_load`, `hayba_get_tool_signature`, `hayba_invoke`, `check_ue_status`)
plus whatever packs are listed in `Saved/HaybaMCP/settings.json#alwaysLoadPacks`.

The LLM discovers tools via `hayba_search_tools` (BM25 + embeddings),
loads a workflow pack via `hayba_pack_load` (typed tools appear via
`notifications/tools/list_changed`), or calls a single tool via
`hayba_invoke(name, args)` without loading its pack.

### Switching to legacy mode

For MCP clients that don't honor `listChanged`, edit `Saved/HaybaMCP/settings.json`:
```json
{ "toolRouting": "full", "alwaysLoadPacks": [] }
```
or set it from the UE plugin's MCP settings panel. Restart the MCP server.

### Adding a tool

Place handler in a subdirectory under `src/tools/<pack>/`. The directory
name becomes the pack name. For root-level tools, set `pack: "<name>"`
in `HaybaToolMeta`. To include the tool in workflow packs (e.g. `biome`),
add its name to `src/tools/routing/packs.yaml`.
```

- [ ] **Step 2: Smoke check**

Read the doc back: `cat D:/Hackathons/hayba/mcp-tools/hayba-mcp/CONTEXT.md | head -80`

- [ ] **Step 3: Commit**

```bash
git add mcp-tools/hayba-mcp/CONTEXT.md
git commit -m "docs(mcp-routing): document deferred mode + pack workflow in CONTEXT.md"
```

---

### Task 17: UE plugin settings field stub

**Files:**
- Locate the UE plugin source under `unreal/` (or wherever `FHaybaMCPSettings` lives).

This task is a stub for the C++ side. The MCP server already reads the JSON file regardless of who writes it, so a user can edit `Saved/HaybaMCP/settings.json` by hand today. This task captures the work needed on the UE plugin side for parity with `disabled-tools.json`.

- [ ] **Step 1: Locate plugin settings code**

Run: `grep -rn "disabled-tools.json" D:/Hackathons/hayba/unreal/ 2>/dev/null | head`

- [ ] **Step 2: Add `ToolRouting` enum and `AlwaysLoadPacks` array to `FHaybaMCPSettings`**

Mirror the existing disabled-tools serialization. Write to `Saved/HaybaMCP/settings.json` alongside the existing `disabled-tools.json`. Add a Slate combo box for the mode picker and a multiselect for pack names (populated from `packs.yaml` parsed by the plugin OR hardcoded for v1 — note as v1 follow-up).

- [ ] **Step 3: Commit**

```bash
git add unreal/...
git commit -m "feat(ue-plugin): toolRouting + alwaysLoadPacks fields in MCP settings panel"
```

---

### Task 18: Manual smoke test + PR

**Files:** none (verification step).

- [ ] **Step 1: Build everything**

```bash
cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npm run build
```

- [ ] **Step 2: Start MCP, connect Claude Code, observe**

In Claude Code (a fresh window), connect to the rebuilt MCP. Observe the tool count drops to 6 at session start.

Prompt: "search for biome tools" → expect `hayba_search_tools` returns `create_pcg_graph` etc.
Prompt: "load the biome pack" → expect `hayba_pack_load("biome")` returns added tools; subsequent tool listing in Claude includes them.
Prompt: "spawn an actor without loading the actor pack" → expect Claude uses `hayba_invoke("actor_spawn", { ... })`.

- [ ] **Step 3: Compare token cost**

Before/after token count of `tools/list` response. Document delta in PR description (expect ~95% reduction at session start).

- [ ] **Step 4: Push branch + open PR**

```bash
git push -u origin spec/mcp-tool-routing
gh pr create --title "MCP tool routing — γ hybrid (Context Layer)" --body "$(cat <<'EOF'
## Summary
- Deferred MCP tool registration: 6 meta-tools + on-demand pack loading via notifications/tools/list_changed
- Hybrid BM25 + embedding tool search (Ollama → @huggingface/transformers fallback → BM25-only)
- Polymorphic hayba_invoke escape hatch for cross-pack calls
- Routing mode + alwaysLoadPacks picked via UE plugin settings (Saved/HaybaMCP/settings.json)
- Legacy "full" mode preserved for MCP clients that don't honor listChanged

## Spec
docs/superpowers/specs/2026-05-20-mcp-tool-routing-design.md

## Test plan
- [ ] Unit: vitest passes for settings-watcher, pack-registry, pack-discovery, tool-index, all meta-tools
- [ ] Integration: routing-integration.test.ts covers deferred + full modes and editor autoload
- [ ] Manual: Claude Code session shows ~6 tools at start, pack_load adds typed tools live
- [ ] Token-cost delta documented
EOF
)"
```

---

## Self-review notes

Coverage check against the spec:
- §Architecture (PackRegistry, ToolIndex, RoutingMode) → Tasks 2, 4, 5, 6, 7, 8
- §Routing modes (deferred/full) → Task 13
- §Pack types (domain auto-derive + workflow YAML + explicit `pack` for root-level) → Tasks 3, 5
- §Always-on surface (6 meta-tools) → Tasks 9, 10, 11; existing `check-ue-status` + `get-tool-signature` are reused
- §Settings file → Task 2
- §Index pipeline (BM25 + embeddings + cache + hash) → Tasks 6, 7, 8
- §Data flow (session start, exploration, cross-pack, UE connect, tool added) → Tasks 13, 14, 15
- §Error handling (validation, disabled, unknown_pack, listChanged-not-honored doc) → Tasks 10, 11, 16
- §Testing (unit, integration, smoke) → Tasks 2, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 18
- §File layout → matches task file paths
- §Risks → autoload race covered by Promise lock in Task 4; cache corruption covered in Task 8; staleness validation noted in Task 13 (workflow pack lookup logs warnings for unknown tools)

Outstanding gaps fixed inline:
- Task 13's `registerRouting` was missing the warning log for unknown tool refs in workflow packs — add this when implementing `loadWorkflowPacks` integration:
  ```ts
  const knownNames = new Set(allTools.map(t => t.name));
  for (const wp of workflowPacks) {
    for (const tn of wp.tools) if (!knownNames.has(tn)) {
      console.warn(`[routing] workflow pack "${wp.name}" references unknown tool "${tn}"`);
    }
  }
  ```
- `hayba_get_tool_signature` already exists in `code-mode/get-tool-signature.ts`; Task 13's register step should keep registering it as always-on (it's one of the 6). Add to `registerRouting` alongside the other meta-tools.

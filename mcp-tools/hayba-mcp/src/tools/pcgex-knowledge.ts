/** Optional, local PCGExKnowledge reader. Documentation is never UE runtime truth. */
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_HITS = 8;
const text = (value: unknown, max = 1200) => typeof value === 'string' ? value.slice(0, max) : '';
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const strings = (value: unknown, max = 20): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, max).map(v => v.slice(0, 500)) : [];

type PluginMeta = { plugin: string; version?: string; file: string; entries: number; stale?: number };
type Manifest = { bundle_schema: string; generated: string; plugins: PluginMeta[] };
type SearchRow = { id: string; name: string; plugin: string; kind: 'entry' | 'concept'; classification?: string; category?: string; purpose?: string; situation?: string; aliases?: string[]; presets?: string[]; outline?: string[]; url?: string };
type Bundle = { root: string; manifest: Manifest; search: SearchRow[]; pluginCache: Map<string, Record<string, unknown>> };

function bundleRoot(): string | null {
  const explicit = process.env.HAYBA_PCGEX_KNOWLEDGE_DIR?.trim();
  if (explicit) return resolve(explicit);
  for (const candidate of [join(packageRoot, 'Resources', 'PCGExKnowledge'), join(packageRoot, '..', '..', 'Resources', 'PCGExKnowledge')]) {
    try { if (statSync(join(candidate, 'manifest.json')).isFile()) return candidate; } catch { /* optional */ }
  }
  return null;
}

function readJson(root: string, file: string): unknown {
  if (!/^[A-Za-z0-9_-]+\.json$/.test(file) || isAbsolute(file)) throw new Error('Invalid bundle filename');
  const path = join(root, file);
  const size = statSync(path).size;
  if (size > MAX_FILE_BYTES) throw new Error(`Bundle file exceeds ${MAX_FILE_BYTES} bytes: ${file}`);
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function loadBundle(): Bundle {
  const root = bundleRoot();
  if (!root) throw new Error('PCGExKnowledge bundle is not configured');
  const rawManifest = record(readJson(root, 'manifest.json'));
  if (!rawManifest || !/^2\.(?:0|1|[2-9]\d*)\.\d+$/.test(text(rawManifest.bundle_schema, 30)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(text(rawManifest.generated, 30)) || !Array.isArray(rawManifest.plugins) || !rawManifest.plugins.length) {
    throw new Error('Unsupported or invalid PCGExKnowledge manifest');
  }
  const plugins = rawManifest.plugins.map(record);
  if (plugins.some(p => !p || !/^[A-Za-z0-9_-]+$/.test(text(p.plugin, 100)) ||
    !/^[A-Za-z0-9_-]+\.json$/.test(text(p.file, 200)) || !Number.isSafeInteger(p.entries) || (p.entries as number) < 0 ||
    (p.version !== undefined && typeof p.version !== 'string'))) throw new Error('Invalid PCGExKnowledge plugin manifest');
  const manifest = rawManifest as unknown as Manifest;
  const rawSearch = readJson(root, 'search.json');
  if (!Array.isArray(rawSearch) || rawSearch.length > 20000 || rawSearch.some(row => {
    const r = record(row);
    return !r || !text(r.id, 500) || !text(r.name, 500) || !plugins.some(p => p?.plugin === r.plugin) ||
      !['entry', 'concept'].includes(String(r.kind)) || (r.kind === 'entry' && !text(r.classification, 100));
  })) throw new Error('Invalid PCGExKnowledge search index');
  return { root, manifest, search: rawSearch as SearchRow[], pluginCache: new Map() };
}

function provenance(bundle: Bundle, plugin: string) {
  const meta = bundle.manifest.plugins.find(p => p.plugin === plugin);
  return { source: 'PCGExKnowledge', bundleSchema: bundle.manifest.bundle_schema, generated: bundle.manifest.generated,
    plugin, documentedPluginVersion: meta?.version ?? null, manifestStaleEntries: meta?.stale ?? 0,
    note: 'Documentation snapshot; compare with the installed plugin and UE reflection before graph authoring.' };
}

export function searchPcgexKnowledge(query: string) {
  try {
    const bundle = loadBundle();
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, 12);
    if (!terms.length) return { available: true, results: [] };
    const ranked = bundle.search.map(row => {
      const haystack = [row.id, row.name, row.category, row.plugin, row.classification, row.purpose,
        row.situation, ...strings(row.aliases), ...strings(row.presets), ...strings(row.outline)].join(' ').toLowerCase();
      if (!terms.every(term => haystack.includes(term))) return null;
      const id = row.id.toLowerCase(), name = row.name.toLowerCase();
      const score = (id === query.toLowerCase() ? 100 : 0) + (name === query.toLowerCase() ? 50 : 0) +
        terms.filter(term => name.includes(term)).length * 10 + terms.filter(term => id.includes(term)).length * 5;
      return { row, score };
    }).filter((v): v is { row: SearchRow; score: number } => !!v).sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
    if (!ranked.length && /^(?:U|F|E)PCGEx[A-Za-z0-9_]+$/.test(query)) {
      const found = resolveEntry(bundle, query);
      if (found) return { available: true, total: 1, results: [{
        id: found.canonical, requestedId: query, name: text(found.entry.name, 200), kind: 'entry' as const,
        classification: text(found.entry.classification, 80),
        placeableInPcgGraph: ['node', 'provider'].includes(String(found.entry.classification)),
        purpose: text(found.entry.purpose, 500), url: text(found.entry.url, 500),
        ...provenance(bundle, found.meta.plugin),
      }] };
    }
    return { available: true, total: ranked.length, results: ranked.slice(0, MAX_HITS).map(({ row }) => ({
      id: text(row.id, 500), name: text(row.name, 200), kind: row.kind, classification: text(row.classification, 80) || null,
      placeableInPcgGraph: row.kind === 'entry' && ['node', 'provider'].includes(row.classification ?? ''),
      purpose: text(row.purpose, 500), situation: text(row.situation, 500), url: text(row.url, 500),
      ...provenance(bundle, row.plugin),
    })) };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : 'Invalid PCGExKnowledge bundle', results: [] };
  }
}

function pluginData(bundle: Bundle, meta: PluginMeta) {
  const cached = bundle.pluginCache.get(meta.file);
  if (cached) return cached;
  const data = record(readJson(bundle.root, meta.file));
  if (!data || data.plugin !== meta.plugin || (meta.version && data.version !== meta.version) ||
    !record(data.entries) || !record(data.aliases) || !record(data.enums)) throw new Error(`Invalid plugin data: ${meta.plugin}`);
  bundle.pluginCache.set(meta.file, data);
  return data;
}

function resolveEntry(bundle: Bundle, id: string) {
  for (const meta of bundle.manifest.plugins) {
    const data = pluginData(bundle, meta);
    const entries = data.entries as Record<string, unknown>;
    const aliases = data.aliases as Record<string, unknown>;
    const canonical = Object.hasOwn(entries, id) ? id : aliases[id];
    if (typeof canonical !== 'string') continue;
    const entry = record(entries[canonical]);
    if (!entry || entry.id !== canonical || entry.plugin !== meta.plugin || !text(entry.classification, 100) || !record(entry.source)) {
      throw new Error(`Invalid entry: ${String(canonical)}`);
    }
    return { entry, canonical, alias: canonical !== id ? id : null, meta };
  }
  return null;
}

export function getPcgexKnowledgeDetail(id: string) {
  try {
    const bundle = loadBundle();
    // Concept IDs are only unique within a plugin; a caller may pass plugin:id.
    const concept = bundle.search.find(row => row.kind === 'concept' && (row.id === id || `${row.plugin}:${row.id}` === id));
    if (concept) {
      const pages = readJson(bundle.root, 'concepts.json');
      if (!Array.isArray(pages)) throw new Error('Invalid concepts file');
      const page = pages.map(record).find(p => p?.id === concept.id && p.plugin === concept.plugin);
      if (!page) throw new Error('Concept missing from concepts file');
      return { available: true, found: true, kind: 'concept', id: concept.id, name: text(page.title, 200), description: text(page.description),
        outline: strings(page.outline, 40), body: text(page.body, 12000), truncated: typeof page.body === 'string' && page.body.length > 12000,
        url: text(page.url, 500), ...provenance(bundle, concept.plugin) };
    }
    const found = resolveEntry(bundle, id);
    if (!found) return { available: true, found: false, id, ...provenance(bundle, '') };
    const { entry, canonical, alias, meta } = found;
    const source = entry.source as Record<string, unknown>;
    const settings = record(entry.settings) ?? {};
    const settingEntries = Object.entries(settings).slice(0, 40).map(([name, raw]) => {
      const s = record(raw) ?? {};
      return { name: text(name, 120), display: text(s.display, 120), type: text(s.type, 120), default: text(s.default, 300),
        tooltip: text(s.tooltip, 500), semantics: text(s.semantics, 800), trap: text(s.trap, 800),
        see: text(s.see, 160), from: text(s.from, 160), enum: text(s.enum, 120),
        overridable: s.overridable === true, editCondition: text(s.edit_condition, 250),
        fields: Array.isArray(s.fields) ? s.fields.slice(0, 12).map(f => { const field = record(f) ?? {}; return { name: text(field.name, 120), type: text(field.type, 120), default: text(field.default, 200) }; }) : [] };
    });
    const pins = record(entry.pins) ?? {};
    const pinList = (value: unknown) => Array.isArray(value) ? value.slice(0, 30).map(v => {
      const p = record(v) ?? {};
      return { label: text(p.label, 120), required: text(p.required, 40), condition: text(p.condition, 300), note: text(p.note, 500) };
    }) : [];
    const inherited = strings(entry.inherits, 15);
    const referenced = [...inherited, ...settingEntries.map(s => s.see).filter(Boolean)].slice(0, 25);
    return { available: true, found: true, kind: 'entry', id: canonical, requestedId: id, resolvedAlias: alias,
      name: text(entry.name, 200), classification: entry.classification,
      placeableInPcgGraph: ['node', 'provider'].includes(String(entry.classification)),
      purpose: text(entry.purpose, 1800), situation: text(entry.situation, 1200), mechanism: text(record(entry.mechanism)?.text, 2000),
      mechanismSteps: strings(record(entry.mechanism)?.steps, 12), variants: Array.isArray(entry.variants) ? entry.variants.slice(0, 15).map(v => { const variant = record(v) ?? {}; return { id: text(variant.id, 160), name: text(variant.name, 160) }; }) : [],
      pins: { inputs: pinList(pins.inputs), outputs: pinList(pins.outputs), dynamic: text(pins.dynamic, 400) },
      settings: settingEntries, settingsTruncated: Object.keys(settings).length > 40,
      inherits: inherited, references: referenced.map(ref => { const target = resolveEntry(bundle, ref); return { requestedId: ref, id: target?.canonical ?? null, plugin: target?.meta.plugin ?? null }; }),
      hints: Array.isArray(entry.hints) ? entry.hints.slice(0, 12).map(v => { const h = record(v) ?? {}; return { style: text(h.style, 30), text: text(h.text, 800) }; }) : [],
      url: text(entry.url, 500), sourceHeader: text(source.file, 300), sourceHash: text(source.hash, 100), sourceStale: source.stale === true,
      ...provenance(bundle, meta.plugin) };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : 'Invalid PCGExKnowledge bundle' };
  }
}

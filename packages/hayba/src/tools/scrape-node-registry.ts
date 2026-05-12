import { z } from 'zod';
import { readdirSync, readFileSync, statSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const schema = z.object({
  pluginSourcePath: z.string().optional().describe('Path to PCGExtendedToolkit/Source/ directory'),
  outputDbPath: z.string().optional().describe('Path for the output SQLite database'),
  forceRescan: z.boolean().optional().default(false).describe('Force re-scan even if DB exists'),
});

export type ScrapeNodeRegistryParams = z.infer<typeof schema>;

import { config } from '../config.js';
const DEFAULT_SOURCE_PATH = process.env.HAYBA_PCGEX_SOURCE
  || 'D:/UnrealEngine/geoforge/Plugins/PCGExtendedToolkit/Source';
const DEFAULT_DB_PATH = config.pcgexDbPath;

function walkHeaderFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = `${dir}/${entry}`;
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) results.push(...walkHeaderFiles(full));
        else if (entry.endsWith('.h')) results.push(full);
      } catch { /* skip inaccessible */ }
    }
  } catch { /* skip inaccessible dirs */ }
  return results;
}

interface NodeInfo { className: string; module: string; displayName: string; description: string; headerPath: string; }
interface PinInfo { nodeClass: string; name: string; direction: 'input' | 'output'; pinType: string; required: boolean; description: string; }
interface PropertyInfo { nodeClass: string; propertyName: string; cppType: string; isPcgOverridable: boolean; description: string; }

function extractModule(headerPath: string, sourcePath: string): string {
  const rel = headerPath.replace(sourcePath.replace(/\\/g, '/'), '').replace(/\\/g, '/');
  const parts = rel.split('/').filter(Boolean);
  return parts[0] || 'Unknown';
}

/**
 * Pre-pass: scan all headers for `const FName <Name> = TEXT("<Value>")` or
 * `inline const FName ... = FName(TEXT("..."))` style declarations and build
 * a lookup table. PCGEx pin labels are emitted into the catalog as their
 * fully-qualified C++ symbol (`PCGExClusters::Labels::OutputEdgesLabel`),
 * which is useless to an LLM authoring graphs — resolve those to the actual
 * runtime FName string (e.g. "Edges").
 */
function buildLabelTable(headerPaths: string[]): Map<string, string> {
  // Map: bare symbol name → resolved FName value. PCGEx Label names are
  // unique enough across the codebase that bare-name lookup is sufficient
  // — collisions would be visible as inconsistent values, and a later
  // pass could namespace-qualify if it ever becomes an issue.
  const labels = new Map<string, string>();
  // Accept all four flavors PCGEx uses in practice:
  //   const FName X = TEXT("foo");
  //   const FName X = FName(TEXT("foo"));
  //   const FName X = FName("foo");
  //   static inline const FName X = FName("foo");
  const labelRe = /(?:static\s+)?(?:inline\s+)?const\s+FName\s+(\w+)\s*=\s*(?:FName\s*\(\s*)?(?:TEXT\s*\(\s*)?"([^"]+)"/g;
  for (const headerPath of headerPaths) {
    try {
      const content = readFileSync(headerPath, 'utf-8');
      for (const m of content.matchAll(labelRe)) {
        // Don't overwrite a previously-seen mapping unless it agrees; if
        // it disagrees, the second value wins (last wins, deterministic
        // enough for now and easy to extend with namespace tracking later).
        labels.set(m[1], m[2]);
      }
    } catch { /* skip */ }
  }
  return labels;
}

function resolvePinLabel(raw: string, labels: Map<string, string>): string {
  // Resolve `Foo::Bar::OutputEdgesLabel` → "Edges" by trailing-symbol
  // lookup. Leave already-string-literal pin names alone.
  if (!raw.includes('::')) return raw;
  const bare = raw.split('::').pop() ?? raw;
  return labels.get(bare) ?? raw;
}

function extractPinsFromImpl(
  cppContent: string,
  className: string,
  methodName: 'InputPinProperties' | 'OutputPinProperties',
  direction: 'input' | 'output',
): PinInfo[] {
  const pins: PinInfo[] = [];
  // Find: `<ReturnType> <className>::<methodName>(...) const { ... }`
  // Body is the balanced-brace chunk after the signature.
  const sigRe = new RegExp(
    String.raw`\b${className}::${methodName}\s*\([^)]*\)\s*const\s*\{`,
    's'
  );
  const m = sigRe.exec(cppContent);
  if (!m) return pins;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < cppContent.length && depth > 0) {
    const ch = cppContent[i++];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  const body = cppContent.slice(start, i - 1);

  // PCGEX_PIN_<KIND>(<labelExpr>, "<tooltip>", <flag?>) — labelExpr may be a
  // namespaced constant like `PCGExGraph::SourceVtxFiltersLabel` or a string.
  // The label must run up to the first comma (or closing paren for the
  // 1-arg form). The description is the next quoted string if present.
  // Greedy on the label so it runs all the way to the comma (the char class
  // already excludes "," and ")" so greedy is safe). Optional `, "desc"`.
  const pinCallRe = /PCGEX_PIN_(\w+)\s*\(\s*([^,)]+)(?:\s*,\s*"((?:[^"\\]|\\.)*)")?[^)]*\)/g;
  for (const pm of body.matchAll(pinCallRe)) {
    const kind = pm[1];
    if (kind === 'TOOLTIP') continue;
    let label = pm[2].trim().replace(/^FName\s*\(\s*/, '').replace(/\)$/, '');
    label = label.replace(/^TEXT\s*\(\s*/, '').replace(/\)$/, '');
    label = label.replace(/^"(.*)"$/, '$1');
    const typeFromKind = kind.replace(/_(SINGLE|ARRAY|REQUIRED|ADVANCED)$/i, '').toLowerCase();
    const required = /REQUIRED/i.test(kind);
    const description = (pm[3] ?? '').replace(/\\"/g, '"');
    pins.push({ nodeClass: className, name: label, direction, pinType: typeFromKind, required, description });
  }
  return pins;
}

function parseHeader(content: string, headerPath: string, sourcePath: string, cppContent: string | null): {
  node?: NodeInfo; pins: PinInfo[]; properties: PropertyInfo[];
} {
  const pins: PinInfo[] = [];
  const properties: PropertyInfo[] = [];

  // Modern PCGEx uses UCLASS(MinimalAPI, ...) with NO API macro; older code
  // uses MODULE_API. Match both: API macro optional.
  const classMatch = content.match(/class\s+(?:\w+_API\s+)?(UPCGEx\w+Settings)\s*[:\s{]/);
  if (!classMatch) return { pins, properties };
  const className = classMatch[1];

  const nodeInfoMatch = content.match(/PCGEX_NODE_INFOS\s*\(\s*\w+\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"/s);
  const displayName = nodeInfoMatch ? nodeInfoMatch[1] : className;
  const description = nodeInfoMatch ? nodeInfoMatch[2] : '';

  const module = extractModule(headerPath, sourcePath);
  const node: NodeInfo = { className, module, displayName, description, headerPath };

  // Some older PCGEx code overrides GetInputPins/GetOutputPins in the header.
  const scanHeaderPins = (methodName: string, direction: 'input' | 'output') => {
    const sec = content.match(new RegExp(methodName + String.raw`[\s\S]*?\{([\s\S]*?)\}`));
    if (!sec) return;
    for (const m of sec[1].matchAll(/FName\s*\(\s*(?:TEXT\s*\()?\s*"([^"]+)"/g)) {
      pins.push({ nodeClass: className, name: m[1], direction, pinType: 'Any', required: false, description: '' });
    }
    for (const m of sec[1].matchAll(/PCGEX_PIN_\w+\s*\(\s*(\w+)\s*[,)]/g)) {
      pins.push({ nodeClass: className, name: m[1], direction, pinType: 'Any', required: false, description: '' });
    }
  };
  scanHeaderPins('GetInputPins', 'input');
  scanHeaderPins('GetOutputPins', 'output');

  // Modern PCGEx puts pin definitions in the .cpp's *PinProperties() override.
  if (cppContent) {
    pins.push(...extractPinsFromImpl(cppContent, className, 'InputPinProperties', 'input'));
    pins.push(...extractPinsFromImpl(cppContent, className, 'OutputPinProperties', 'output'));
  }

  // UE's UPROPERTY(...) commonly contains `meta=(...)` — a single nested paren
  // pair — so a naive [^)]* breaks. Balance one level of nesting.
  const upropRe = /UPROPERTY\s*\(((?:[^()]|\([^()]*\))*)\)\s*\n?\s*(\w[\w:<>*& ]+?)\s+(\w+)\s*[=;{]/g;
  for (const m of content.matchAll(upropRe)) {
    if (!m[1].includes('PCG_Overridable')) continue;
    // Pull the /** ... */ docstring IMMEDIATELY preceding this UPROPERTY.
    // Walk all doc blocks in the lookbehind window, take the last one, and
    // require it to be adjacent (only whitespace between it and the
    // UPROPERTY) — otherwise we'd grab the previous property's doc.
    const lookbehindStart = Math.max(0, m.index! - 800);
    const lookbehind = content.slice(lookbehindStart, m.index);
    const blocks = [...lookbehind.matchAll(/\/\*\*\s*([\s\S]*?)\s*\*\//g)];
    let description = '';
    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      const blockEnd = last.index! + last[0].length;
      const gap = lookbehind.slice(blockEnd);
      if (/^\s*$/.test(gap)) {
        description = last[1]
          .split('\n')
          .map(line => line.replace(/^\s*\*\s?/, '').trim())
          .filter(line => line.length > 0)
          .join(' ');
      }
    }
    properties.push({
      nodeClass: className,
      propertyName: m[3],
      cppType: m[2].trim(),
      isPcgOverridable: true,
      description,
    });
  }

  return { node, pins, properties };
}

export async function scrapeNodeRegistry(params: ScrapeNodeRegistryParams) {
  const { pluginSourcePath, outputDbPath, forceRescan } = schema.parse(params);
  const sourcePath = (pluginSourcePath || DEFAULT_SOURCE_PATH).replace(/\\/g, '/');
  const dbPath = outputDbPath || DEFAULT_DB_PATH;
  const startMs = Date.now();
  const errors: string[] = [];

  // BUG-5: forceRescan should delete the DB file so schema changes take effect
  if (forceRescan && existsSync(dbPath)) {
    try { unlinkSync(dbPath); } catch { /* ignore */ }
  }

  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(dbPath);
  } catch (e: any) {
    return { nodesFound: 0, dbPath, durationMs: 0, errors: [`Failed to open DB: ${e.message}`] };
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      class TEXT PRIMARY KEY, module TEXT, display_name TEXT, description TEXT, header_path TEXT
    );
    CREATE TABLE IF NOT EXISTS pins (
      id INTEGER PRIMARY KEY AUTOINCREMENT, node_class TEXT, name TEXT, direction TEXT, type TEXT, required INTEGER, description TEXT
    );
    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT, node_class TEXT, property_name TEXT, cpp_type TEXT, is_pcg_overridable INTEGER, description TEXT
    );
  `);

  const headers = walkHeaderFiles(sourcePath);
  // Pre-pass: resolve PCGEx pin-label symbols (Foo::Labels::OutputEdgesLabel
  // → "Edges") so the catalog ships clean FName strings, not C++ refs.
  const labelTable = buildLabelTable(headers);
  let nodesFound = 0;

  const insertNode = db.prepare(
    'INSERT OR REPLACE INTO nodes(class, module, display_name, description, header_path) VALUES (?,?,?,?,?)'
  );
  const insertPin = db.prepare(
    'INSERT INTO pins(node_class, name, direction, type, required, description) VALUES (?,?,?,?,?,?)'
  );
  const insertProp = db.prepare(
    'INSERT INTO properties(node_class, property_name, cpp_type, is_pcg_overridable, description) VALUES (?,?,?,?,?)'
  );
  // BUG-3: delete existing pins/properties before reinserting to avoid duplicates on non-force rescan
  const deletePins = db.prepare('DELETE FROM pins WHERE node_class = ?');
  const deleteProps = db.prepare('DELETE FROM properties WHERE node_class = ?');

  for (const headerPath of headers) {
    try {
      const content = readFileSync(headerPath, 'utf-8');
      // PCGEx convention: header at Public/.../Foo.h, impl at Private/.../Foo.cpp
      const cppPath = headerPath.replace('/Public/', '/Private/').replace(/\.h$/, '.cpp');
      let cppContent: string | null = null;
      try { cppContent = readFileSync(cppPath, 'utf-8'); } catch { /* no impl file — ok */ }
      const { node, pins, properties } = parseHeader(content, headerPath, sourcePath, cppContent);
      if (node) {
        deletePins.run(node.className);
        deleteProps.run(node.className);
        insertNode.run(node.className, node.module, node.displayName, node.description, node.headerPath);
        for (const pin of pins) {
          const resolvedName = resolvePinLabel(pin.name, labelTable);
          insertPin.run(pin.nodeClass, resolvedName, pin.direction, pin.pinType, pin.required ? 1 : 0, pin.description);
        }
        for (const prop of properties) insertProp.run(prop.nodeClass, prop.propertyName, prop.cppType, prop.isPcgOverridable ? 1 : 0, prop.description);
        nodesFound++;
      }
    } catch (e: any) {
      errors.push(`${headerPath}: ${e.message}`);
    }
  }

  // Side-effect: emit node_catalog.json alongside the DB. The MCP catalog
  // loader reads the JSON, not the DB directly — keep them in sync without
  // a manual regen step.
  const catalogPath = join(dirname(dbPath), 'node_catalog.json');
  try {
    const allNodes = db.prepare('SELECT * FROM nodes').all() as Array<{
      class: string; module: string; display_name: string; description: string; header_path: string;
    }>;
    const pinSt = db.prepare('SELECT name, direction, type, required, description FROM pins WHERE node_class=?');
    const propSt = db.prepare('SELECT property_name, cpp_type, is_pcg_overridable, description FROM properties WHERE node_class=?');
    const byModule: Record<string, any[]> = {};
    for (const n of allNodes) {
      const pins = pinSt.all(n.class) as Array<{ name: string; direction: string; type: string; required: number; description: string }>;
      const props = propSt.all(n.class) as Array<{ property_name: string; cpp_type: string; is_pcg_overridable: number; description: string }>;
      const entry = {
        class: n.class,
        display_name: n.display_name || n.class,
        description: n.description || '',
        input_pins:  pins.filter(p => p.direction === 'input').map(p => ({ name: p.name, type: p.type, required: !!p.required, tooltip: p.description || '' })),
        output_pins: pins.filter(p => p.direction === 'output').map(p => ({ name: p.name, type: p.type, tooltip: p.description || '' })),
        properties:  Object.fromEntries(props.map(p => [p.property_name, {
          type: p.cpp_type,
          description: p.description || '',
          is_pcg_overridable: !!p.is_pcg_overridable,
        }])),
      };
      (byModule[n.module] ||= []).push(entry);
    }
    const catalog = {
      _meta: { version_support: ['1.0'], generated: new Date().toISOString(), source_db: 'pcgex_registry.db', node_count: allNodes.length },
      categories: Object.fromEntries(Object.entries(byModule).map(([m, ns]) => [m, { description: `PCGEx module: ${m}`, nodes: ns }])),
    };
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  } catch (e: any) {
    errors.push(`node_catalog.json regen: ${e.message}`);
  }

  return { nodesFound, dbPath, catalogPath, durationMs: Date.now() - startMs, errors };
}

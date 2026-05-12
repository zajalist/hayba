import { z } from 'zod';
import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from 'node:fs';
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
interface PinInfo { nodeClass: string; name: string; direction: 'input' | 'output'; pinType: string; required: boolean; }
interface PropertyInfo { nodeClass: string; propertyName: string; cppType: string; isPcgOverridable: boolean; }

function extractModule(headerPath: string, sourcePath: string): string {
  const rel = headerPath.replace(sourcePath.replace(/\\/g, '/'), '').replace(/\\/g, '/');
  const parts = rel.split('/').filter(Boolean);
  return parts[0] || 'Unknown';
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
  for (const pm of body.matchAll(/PCGEX_PIN_(\w+)\s*\(\s*([^,)]+?)\s*[,)]/g)) {
    const kind = pm[1];                          // POINTS / PARAM / ANY / TOOLTIP / …
    if (kind === 'TOOLTIP') continue;            // not a pin
    let label = pm[2].trim().replace(/^FName\s*\(\s*/, '').replace(/\)$/, '');
    label = label.replace(/^TEXT\s*\(\s*/, '').replace(/\)$/, '');
    label = label.replace(/^"(.*)"$/, '$1');
    const typeFromKind = kind.replace(/_(SINGLE|ARRAY|REQUIRED|ADVANCED)$/i, '').toLowerCase();
    const required = /REQUIRED/i.test(kind);
    pins.push({ nodeClass: className, name: label, direction, pinType: typeFromKind, required });
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
      pins.push({ nodeClass: className, name: m[1], direction, pinType: 'Any', required: false });
    }
    for (const m of sec[1].matchAll(/PCGEX_PIN_\w+\s*\(\s*(\w+)\s*[,)]/g)) {
      pins.push({ nodeClass: className, name: m[1], direction, pinType: 'Any', required: false });
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
    properties.push({ nodeClass: className, propertyName: m[3], cppType: m[2].trim(), isPcgOverridable: true });
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
      id INTEGER PRIMARY KEY AUTOINCREMENT, node_class TEXT, name TEXT, direction TEXT, type TEXT, required INTEGER
    );
    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT, node_class TEXT, property_name TEXT, cpp_type TEXT, is_pcg_overridable INTEGER
    );
  `);

  const headers = walkHeaderFiles(sourcePath);
  let nodesFound = 0;

  const insertNode = db.prepare(
    'INSERT OR REPLACE INTO nodes(class, module, display_name, description, header_path) VALUES (?,?,?,?,?)'
  );
  const insertPin = db.prepare(
    'INSERT INTO pins(node_class, name, direction, type, required) VALUES (?,?,?,?,?)'
  );
  const insertProp = db.prepare(
    'INSERT INTO properties(node_class, property_name, cpp_type, is_pcg_overridable) VALUES (?,?,?,?)'
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
        for (const pin of pins) insertPin.run(pin.nodeClass, pin.name, pin.direction, pin.pinType, pin.required ? 1 : 0);
        for (const prop of properties) insertProp.run(prop.nodeClass, prop.propertyName, prop.cppType, prop.isPcgOverridable ? 1 : 0);
        nodesFound++;
      }
    } catch (e: any) {
      errors.push(`${headerPath}: ${e.message}`);
    }
  }

  return { nodesFound, dbPath, durationMs: Date.now() - startMs, errors };
}

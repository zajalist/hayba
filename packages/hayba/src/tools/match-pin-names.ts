import { z } from 'zod';
import { getNodeByClass } from '../catalog.js';
import { DatabaseSync } from 'node:sqlite';

const schema = z.object({
  fromClass: z.string().describe('Source node class'),
  fromPin: z.string().describe('Pin name on the source node (may be approximate)'),
  toClass: z.string().describe('Target node class to find a matching input pin on'),
});

export type MatchPinNamesParams = z.infer<typeof schema>;

const TYPE_GROUPS: Record<string, string> = {
  Points: 'spatial', Vtx: 'spatial', Edges: 'spatial', Paths: 'spatial',
  Param: 'param', Heuristics: 'param', In: 'any', Out: 'any',
};

function typeGroup(pinName: string): string {
  return TYPE_GROUPS[pinName] || 'any';
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function scorePinMatch(fromPin: string, candidatePin: string) {
  const fp = fromPin.toLowerCase(), cp = candidatePin.toLowerCase();
  if (fp === cp) return { confidence: 1.0, reason: 'exact', typeCompatible: true };

  const dist = levenshtein(fp, cp);
  // BUG-11: guard against NaN when both strings are empty
  const maxLen = Math.max(fp.length, cp.length);
  const similarity = maxLen === 0 ? 1.0 : 1 - dist / maxLen;
  const fromGroup = typeGroup(fromPin), toGroup = typeGroup(candidatePin);
  const typeCompatible = fromGroup === toGroup || fromGroup === 'any' || toGroup === 'any';

  let confidence = similarity * 0.7;
  if (typeCompatible) confidence += 0.2;
  if (cp.includes(fp) || fp.includes(cp)) confidence += 0.1;
  confidence = Math.min(confidence, 0.99);

  const reason = typeCompatible ? 'semantic+type-compatible' : 'semantic';
  return { confidence, reason, typeCompatible };
}

const DB_PATH = 'D:/UnrealEngine/geoforge/Plugins/Hayba_PcgEx_MCP/Resources/pcgex_registry.db';

function getPinsFromDb(nodeClass: string, direction: 'input' | 'output'): string[] {
  try {
    // BUG-7+8: DatabaseSync API — just new DatabaseSync(path), no open/close methods
    const db = new DatabaseSync(DB_PATH);
    const rows = db.prepare('SELECT name FROM pins WHERE node_class = ? AND direction = ?').all(nodeClass, direction) as Array<{ name: string }>;
    return rows.map(r => r.name);
  } catch {
    return [];
  }
}

export async function matchPinNames(params: MatchPinNamesParams) {
  const { fromClass, fromPin, toClass } = schema.parse(params);

  // BUG-9: validate that fromPin exists in fromClass output pins
  let fromPinNote: string | undefined;
  const fromCatalogNode = getNodeByClass(fromClass);
  const fromOutputPins: string[] = fromCatalogNode
    ? fromCatalogNode.outputs.map(p => p.pin)
    : getPinsFromDb(fromClass, 'output');
  if (fromOutputPins.length > 0 && !fromOutputPins.includes(fromPin)) {
    fromPinNote = `Warning: pin "${fromPin}" not found in ${fromClass} output pins [${fromOutputPins.join(', ')}]`;
  }

  let candidatePins: string[] = [];
  const toCatalogNode = getNodeByClass(toClass);
  if (toCatalogNode) candidatePins = toCatalogNode.inputs.map(p => p.pin);
  if (candidatePins.length === 0) candidatePins = getPinsFromDb(toClass, 'input');

  if (candidatePins.length === 0) {
    return { fromPin, matches: [], bestMatch: null, warning: `No input pins found for ${toClass} in catalog or registry`, fromPinNote };
  }

  const matches = candidatePins
    .map(cp => ({ suggestedToPin: cp, ...scorePinMatch(fromPin, cp) }))
    .sort((a, b) => b.confidence - a.confidence);

  return { fromPin, matches, bestMatch: matches[0] ?? null, fromPinNote };
}

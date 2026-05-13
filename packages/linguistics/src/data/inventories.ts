/**
 * Curated cross-linguistic phoneme inventories for the co-occurrence model.
 *
 * Each inventory is a hand-transcribed snapshot of a well-documented language,
 * restricted to the IPA subset exposed by `ipa-chart.ts` so the heatmap is
 * dense over the visible grid. Source: PHOIBLE 2.0 (https://phoible.org,
 * CC-BY-SA 4.0). This is a stopgap dataset for the L1 demo; production builds
 * should swap `INVENTORIES` for a full PHOIBLE export via `loadInventoriesFromPhoible`
 * (or the lazy `loadPhoibleCorpus` accessor below).
 *
 * Inventory simplifications: tone, length, secondary articulation, and any
 * phonemes outside the chart subset are dropped. The shape of the
 * cross-linguistic signal (e.g. /p t k/ near-universal, /ɡ/ gap pattern,
 * nasal-stop POA harmony) is preserved.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname as pathDirname, join as pathJoin } from 'node:path';

export interface InventoryRecord {
  language: string;
  family: string;
  phonemes: string[];
}

export const INVENTORIES: InventoryRecord[] = [
  { language: 'English',     family: 'Indo-European', phonemes: ['p','t','k','b','d','ɡ','m','n','ŋ','f','v','s','z','ʃ','ʒ','h','l','j','w','r','i','e','ɛ','a','u','o','ɔ','ɑ','ə'] },
  { language: 'Spanish',     family: 'Indo-European', phonemes: ['p','t','k','b','d','ɡ','m','n','f','s','ʃ','l','j','w','r','i','e','a','u','o'] },
  { language: 'Japanese',    family: 'Japonic',       phonemes: ['p','t','k','b','d','ɡ','m','n','ŋ','s','z','ʃ','ʒ','h','j','w','r','i','e','a','u','o'] },
  { language: 'Mandarin',    family: 'Sino-Tibetan',  phonemes: ['p','t','k','m','n','ŋ','f','s','ʃ','h','l','j','w','i','e','a','u','o','ə'] },
  { language: 'Arabic-MSA',  family: 'Afro-Asiatic',  phonemes: ['t','k','b','d','m','n','f','s','z','ʃ','h','l','j','w','i','a','u'] },
  { language: 'Hawaiian',    family: 'Austronesian',  phonemes: ['p','k','m','n','h','l','w','i','e','a','u','o'] },
  { language: 'Finnish',     family: 'Uralic',        phonemes: ['p','t','k','m','n','ŋ','v','s','h','l','j','r','i','e','a','u','o'] },
  { language: 'Turkish',     family: 'Turkic',        phonemes: ['p','t','k','b','d','ɡ','m','n','f','v','s','z','ʃ','ʒ','h','l','j','r','i','e','a','u','o'] },
  { language: 'Swahili',     family: 'Niger-Congo',   phonemes: ['p','t','k','b','d','ɡ','m','n','f','v','s','z','ʃ','h','l','j','w','r','i','e','a','u','o'] },
  { language: 'Russian',     family: 'Indo-European', phonemes: ['p','t','k','b','d','ɡ','m','n','f','v','s','z','ʃ','ʒ','h','l','j','r','i','e','a','u','o'] },
  { language: 'French',      family: 'Indo-European', phonemes: ['p','t','k','b','d','ɡ','m','n','ŋ','f','v','s','z','ʃ','ʒ','l','j','w','r','i','e','ɛ','a','u','o','ɔ','ə'] },
  { language: 'German',      family: 'Indo-European', phonemes: ['p','t','k','b','d','ɡ','m','n','ŋ','f','v','s','z','ʃ','ʒ','h','l','j','r','i','e','ɛ','a','u','o','ɔ','ə'] },
  { language: 'Korean',      family: 'Koreanic',      phonemes: ['p','t','k','m','n','ŋ','s','h','l','j','w','i','e','a','u','o','ə'] },
  { language: 'Hindi',       family: 'Indo-European', phonemes: ['p','t','k','b','d','ɡ','m','n','ŋ','s','ʃ','h','l','j','w','r','i','e','a','u','o'] },
  { language: 'Italian',     family: 'Indo-European', phonemes: ['p','t','k','b','d','ɡ','m','n','ŋ','f','v','s','z','ʃ','l','j','w','r','i','e','ɛ','a','u','o','ɔ'] },
  { language: 'Greek',       family: 'Indo-European', phonemes: ['p','t','k','b','d','ɡ','m','n','f','v','s','z','h','l','j','r','i','e','a','u','o'] },
  { language: 'Vietnamese',  family: 'Austroasiatic', phonemes: ['p','t','k','b','d','m','n','ŋ','f','v','s','z','h','l','j','w','i','e','ɛ','a','u','o','ɔ','ə'] },
  { language: 'Thai',        family: 'Kra-Dai',       phonemes: ['p','t','k','b','d','m','n','ŋ','f','s','h','l','j','w','r','i','e','ɛ','a','u','o','ɔ'] },
  { language: 'Yoruba',      family: 'Niger-Congo',   phonemes: ['b','t','k','d','ɡ','m','n','f','s','ʃ','h','l','j','w','r','i','e','ɛ','a','u','o','ɔ'] },
  { language: 'Quechua',     family: 'Quechuan',      phonemes: ['p','t','k','m','n','s','ʃ','h','l','j','w','r','i','a','u'] },
];

// ---------------------------------------------------------------------------
// PHOIBLE CSV loader
// ---------------------------------------------------------------------------

/**
 * Parse a single line of CSV into its fields. Implements the RFC-4180 subset
 * PHOIBLE uses: fields may be unquoted, or wrapped in double-quotes with
 * literal `""` escaping an interior quote. Commas inside quotes are kept.
 *
 * Kept inline (no `papaparse` dep) to keep `@hayba/linguistics` lean.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          buf += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        buf += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        out.push(buf);
        buf = '';
      } else {
        buf += c;
      }
    }
  }
  out.push(buf);
  return out;
}

/**
 * Stream-parse a PHOIBLE CSV export and return one `InventoryRecord` per
 * `InventoryID`. The PHOIBLE wire format we expect is the one published at
 * https://github.com/phoible/dev/blob/master/data/phoible.csv: a header row
 * plus one row per (inventory, phoneme).
 *
 * Critical columns: `InventoryID`, `LanguageName`, `Glottocode`, `ISO6393`,
 * `Phoneme`. `family` is resolved to `Family_Name` when present, else
 * `family_id`, else "unknown". Phonemes are kept in first-seen order and
 * de-duplicated within an inventory; we do not intersect with the chart
 * catalogue (downstream consumers can do that themselves).
 */
export async function loadInventoriesFromPhoible(path: string): Promise<InventoryRecord[]> {
  const { createReadStream } = await import('node:fs');
  const { createInterface } = await import('node:readline');

  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let header: string[] | null = null;
  let idxInv = -1, idxLang = -1, idxPhon = -1, idxFamName = -1, idxFamId = -1;

  // Use Map to preserve insertion order of inventories + per-inventory phonemes.
  const byId = new Map<string, { language: string; family: string; phonemes: string[]; seen: Set<string> }>();

  for await (const line of rl) {
    if (line.length === 0) continue;
    const fields = parseCsvLine(line);
    if (!header) {
      header = fields;
      idxInv = header.indexOf('InventoryID');
      idxLang = header.indexOf('LanguageName');
      idxPhon = header.indexOf('Phoneme');
      idxFamName = header.indexOf('Family_Name');
      idxFamId = header.indexOf('family_id');
      if (idxInv < 0 || idxLang < 0 || idxPhon < 0) {
        throw new Error(
          `hayba: PHOIBLE loader expected columns InventoryID, LanguageName, Phoneme. Got: ${header.join(', ')}`,
        );
      }
      continue;
    }

    const invId = fields[idxInv];
    const phoneme = fields[idxPhon];
    if (!invId || !phoneme) continue;

    let entry = byId.get(invId);
    if (!entry) {
      const famName = idxFamName >= 0 ? fields[idxFamName] : '';
      const famId = idxFamId >= 0 ? fields[idxFamId] : '';
      entry = {
        language: fields[idxLang] || `inventory-${invId}`,
        family: famName || famId || 'unknown',
        phonemes: [],
        seen: new Set<string>(),
      };
      byId.set(invId, entry);
    }
    if (!entry.seen.has(phoneme)) {
      entry.seen.add(phoneme);
      entry.phonemes.push(phoneme);
    }
  }

  return Array.from(byId.values()).map(({ language, family, phonemes }) => ({
    language,
    family,
    phonemes,
  }));
}

/**
 * Lazy accessor for the full PHOIBLE corpus.
 *
 * If `packages/linguistics/src/data/inventories.phoible.json` has been
 * generated via `npm run import:phoible`, return its contents; otherwise
 * fall back to the bundled hand-curated `INVENTORIES` subset. The dynamic
 * import keeps the ~12MB JSON off the hot path for callers that don't ask
 * for it (demos, tests, light tooling).
 *
 * Cached after the first successful resolve.
 */
let _phoibleCache: InventoryRecord[] | null = null;
export function loadPhoibleCorpus(): InventoryRecord[] {
  if (_phoibleCache) return _phoibleCache;
  try {
    // Resolve sibling JSON synchronously without a static import (so the
    // ~12MB file is never bundled or scanned unless present). The file is
    // intentionally gitignored — absence is the common case and yields the
    // bundled subset.
    const here = fileURLToPath(import.meta.url);
    const jsonPath = pathJoin(pathDirname(here), 'inventories.phoible.json');
    const raw = readFileSync(jsonPath, 'utf8');
    const data = JSON.parse(raw) as InventoryRecord[];
    if (Array.isArray(data) && data.length > 0) {
      _phoibleCache = data;
      return data;
    }
  } catch {
    // Fall through to bundled subset.
  }
  _phoibleCache = INVENTORIES;
  return INVENTORIES;
}

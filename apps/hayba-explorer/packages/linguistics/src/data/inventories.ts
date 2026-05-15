/**
 * Curated cross-linguistic phoneme inventories for the co-occurrence model.
 *
 * Each inventory is a hand-transcribed snapshot of a well-documented language,
 * restricted to the IPA subset exposed by `ipa-chart.ts` so the heatmap is
 * dense over the visible grid. Source: PHOIBLE 2.0 (https://phoible.org,
 * CC-BY-SA 4.0). This is a stopgap dataset for the L1 demo; production builds
 * should swap `INVENTORIES` for a full PHOIBLE export via `loadInventoriesFromPhoible`.
 *
 * Inventory simplifications: tone, length, secondary articulation, and any
 * phonemes outside the chart subset are dropped. The shape of the
 * cross-linguistic signal (e.g. /p t k/ near-universal, /ɡ/ gap pattern,
 * nasal-stop POA harmony) is preserved.
 */

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

/**
 * Stub for the production swap-in. Will parse a PHOIBLE TSV export. Kept here
 * so call sites can wire up loading without changing the public surface.
 */
export async function loadInventoriesFromPhoible(_path: string): Promise<InventoryRecord[]> {
  throw new Error('hayba: PHOIBLE TSV loader not yet implemented — use INVENTORIES for now');
}

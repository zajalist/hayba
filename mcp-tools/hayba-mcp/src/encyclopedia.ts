import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PROJECTS_BASE } from './projects.js';

export interface EncyclopediaEntry {
  id: string;
  name: string;
  scientificName?: string;
  type: 'foliage' | 'vegetation' | 'rocks' | 'props' | 'terrain-feature';
  region: string[];
  ueMeshPath: string;
  fabLink?: string;
  attributes: {
    densityPerM2?: number;
    heightMinM?: number;
    heightMaxM?: number;
    canopyCoverage?: number;
    understoryCoverage?: number;
    moistureRequirement?: 'low' | 'medium' | 'high';
    elevationMinM?: number;
    elevationMaxM?: number;
    slopePreference?: 'flat' | 'gentle' | 'steep' | 'any';
  };
  lore?: string;
  isBaseEntry: boolean;
}

function encFile(projectId: string, base: string): string {
  return join(base, projectId, 'encyclopedia.json');
}

export async function getEntries(projectId: string, base = DEFAULT_PROJECTS_BASE): Promise<EncyclopediaEntry[]> {
  const file = encFile(projectId, base);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf-8')) as EncyclopediaEntry[];
}

export async function addEntry(projectId: string, entry: EncyclopediaEntry, base = DEFAULT_PROJECTS_BASE): Promise<void> {
  const entries = await getEntries(projectId, base);
  const idx = entries.findIndex(e => e.id === entry.id);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  writeFileSync(encFile(projectId, base), JSON.stringify(entries, null, 2), 'utf-8');
}

export async function deleteEntry(projectId: string, entryId: string, base = DEFAULT_PROJECTS_BASE): Promise<void> {
  const entries = await getEntries(projectId, base);
  writeFileSync(encFile(projectId, base), JSON.stringify(entries.filter(e => e.id !== entryId), null, 2), 'utf-8');
}

export function getBaseTemplates(): EncyclopediaEntry[] {
  return [
    { id: 'bt-scots-pine', name: 'Scots Pine', scientificName: 'Pinus sylvestris', type: 'foliage', region: ['Boreal', 'Temperate'], ueMeshPath: '', fabLink: 'https://www.fab.com/listings/pine-tree', attributes: { densityPerM2: 0.3, heightMinM: 8, heightMaxM: 25, canopyCoverage: 0.65, understoryCoverage: 0.15, moistureRequirement: 'medium', elevationMinM: 300, elevationMaxM: 2000, slopePreference: 'gentle' }, isBaseEntry: true },
    { id: 'bt-alpine-grass', name: 'Alpine Grass', scientificName: 'Festuca rubra', type: 'vegetation', region: ['Alpine', 'Subalpine'], ueMeshPath: '', fabLink: 'https://www.fab.com/listings/alpine-grass', attributes: { densityPerM2: 12, heightMinM: 0.05, heightMaxM: 0.3, canopyCoverage: 0.85, moistureRequirement: 'medium', elevationMinM: 1200, elevationMaxM: 3500, slopePreference: 'any' }, isBaseEntry: true },
    { id: 'bt-saguaro-cactus', name: 'Saguaro Cactus', scientificName: 'Carnegiea gigantea', type: 'foliage', region: ['Desert', 'Arid'], ueMeshPath: '', fabLink: 'https://www.fab.com/listings/cactus', attributes: { densityPerM2: 0.05, heightMinM: 3, heightMaxM: 12, canopyCoverage: 0.05, moistureRequirement: 'low', elevationMinM: 0, elevationMaxM: 1400, slopePreference: 'gentle' }, isBaseEntry: true },
    { id: 'bt-oak-tree', name: 'English Oak', scientificName: 'Quercus robur', type: 'foliage', region: ['Temperate', 'Mediterranean'], ueMeshPath: '', fabLink: 'https://www.fab.com/listings/oak-tree', attributes: { densityPerM2: 0.15, heightMinM: 10, heightMaxM: 35, canopyCoverage: 0.80, understoryCoverage: 0.35, moistureRequirement: 'medium', elevationMinM: 0, elevationMaxM: 1500, slopePreference: 'gentle' }, isBaseEntry: true },
    { id: 'bt-bamboo', name: 'Moso Bamboo', scientificName: 'Phyllostachys edulis', type: 'foliage', region: ['Tropical', 'Subtropical'], ueMeshPath: '', fabLink: 'https://www.fab.com/listings/bamboo', attributes: { densityPerM2: 4, heightMinM: 10, heightMaxM: 28, canopyCoverage: 0.75, moistureRequirement: 'high', elevationMinM: 0, elevationMaxM: 1500, slopePreference: 'gentle' }, isBaseEntry: true },
    { id: 'bt-granite-boulder', name: 'Granite Boulder', type: 'rocks', region: ['Alpine', 'Boreal', 'Temperate', 'Arctic'], ueMeshPath: '', fabLink: 'https://www.fab.com/listings/rock-boulder', attributes: { densityPerM2: 0.04, heightMinM: 0.5, heightMaxM: 4, slopePreference: 'any' }, isBaseEntry: true },
    { id: 'bt-sandstone-rock', name: 'Sandstone Rock', type: 'rocks', region: ['Desert', 'Arid', 'Mediterranean'], ueMeshPath: '', fabLink: 'https://www.fab.com/listings/sandstone', attributes: { densityPerM2: 0.08, heightMinM: 0.3, heightMaxM: 2, slopePreference: 'gentle' }, isBaseEntry: true },
    { id: 'bt-fern', name: 'Common Fern', scientificName: 'Dryopteris filix-mas', type: 'vegetation', region: ['Temperate', 'Boreal'], ueMeshPath: '', fabLink: 'https://www.fab.com/listings/fern', attributes: { densityPerM2: 3, heightMinM: 0.3, heightMaxM: 1.2, canopyCoverage: 0.5, moistureRequirement: 'high', elevationMinM: 0, elevationMaxM: 2000, slopePreference: 'any' }, isBaseEntry: true },
    { id: 'bt-palm-tree', name: 'Coconut Palm', scientificName: 'Cocos nucifera', type: 'foliage', region: ['Tropical', 'Coastal'], ueMeshPath: '', fabLink: 'https://www.fab.com/listings/palm-tree', attributes: { densityPerM2: 0.08, heightMinM: 10, heightMaxM: 30, canopyCoverage: 0.3, moistureRequirement: 'medium', elevationMinM: 0, elevationMaxM: 400, slopePreference: 'flat' }, isBaseEntry: true },
    { id: 'bt-mountain-ridge', name: 'Mountain Ridge', type: 'terrain-feature', region: ['Alpine', 'Subalpine', 'Boreal'], ueMeshPath: '', attributes: { elevationMinM: 1500, elevationMaxM: 6000, slopePreference: 'steep' }, isBaseEntry: true },
    { id: 'bt-river-bed', name: 'River Bed', type: 'terrain-feature', region: ['Temperate', 'Tropical', 'Boreal'], ueMeshPath: '', attributes: { moistureRequirement: 'high', elevationMinM: 0, elevationMaxM: 3000, slopePreference: 'gentle' }, isBaseEntry: true },
  ];
}

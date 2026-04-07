export interface Zone {
  id: string;
  name: string;
  description: string;
  color: string;
  type: 'terrain' | 'placement';
  placementCategory?: 'foliage' | 'vegetation' | 'rocks' | 'props';
  maskPath: string;
  visible: boolean;
}

export interface ZoneSession {
  projectId: string;
  zones: Zone[];
  masks: { zoneId: string; pngPath: string }[];
  submittedAt: string;
  canvasSize: 1024 | 2048 | 4096;
  phase: 'a' | 'b';
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  lastModified: string;
  terrainPath: string | null;
  bakeStatus: 'none' | 'baked' | 'imported';
}

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

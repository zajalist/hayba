/**
 * @hayba/architecture — schema definitions.
 *
 * Three artifacts: Typology (structural), StyleSheet (cosmetic),
 * StyleGuide (binds the two). All by-value, all readonly-safe.
 */

export type FeatureBundle = Readonly<Record<string, string | readonly string[]>>;

export type RoofType =
  | 'gable' | 'hip' | 'flat' | 'pagoda' | 'thatch' | 'dome' | 'shed' | 'mansard';

export const ROOF_TYPES = [
  'gable', 'hip', 'flat', 'pagoda', 'thatch', 'dome', 'shed', 'mansard',
] as const satisfies readonly RoofType[];

export type PrimaryMaterial =
  | 'stone' | 'timber' | 'mudbrick' | 'adobe' | 'rammed-earth'
  | 'brick' | 'concrete' | 'wattle-daub';

export const PRIMARY_MATERIALS = [
  'stone', 'timber', 'mudbrick', 'adobe', 'rammed-earth',
  'brick', 'concrete', 'wattle-daub',
] as const satisfies readonly PrimaryMaterial[];

export type FootprintKind =
  | 'rectangle' | 'linear-row' | 'L-shape' | 'U-shape' | 'courtyard';

export const FOOTPRINT_KINDS = [
  'rectangle', 'linear-row', 'L-shape', 'U-shape', 'courtyard',
] as const satisfies readonly FootprintKind[];

export type FootprintShape =
  | { kind: 'rectangle';  aspectRatio:        [number, number]; areaRange:        [number, number] }
  | { kind: 'linear-row'; widthRange:         [number, number]; depthRange:       [number, number] }
  | { kind: 'L-shape';    wingDepth:          [number, number]; courtyardFraction:[number, number] }
  | { kind: 'U-shape';    wingDepth:          [number, number]; openingWidth:     [number, number] }
  | { kind: 'courtyard';  courtyardFraction:  [number, number]; wingDepth:        [number, number] };

export interface Typology {
  id: string;
  footprint: FootprintShape;
  storyRange: [number, number];
  fenestrationDensity: [number, number];
  pathfindingHints?: Readonly<Record<string, string>>;
}

export interface StyleSheet {
  id: string;
  cultureId: string;
  dateRange: [number, number];
  core: {
    primaryMaterial: PrimaryMaterial;
    secondaryMaterial?: PrimaryMaterial;
    roofType: RoofType;
    ornamentation: readonly string[];
  };
  extras: FeatureBundle;
}

export interface StyleGuide {
  id: string;
  styleSheet: StyleSheet;
  typologyWeights: ReadonlyArray<{ typologyId: string; weight: number }>;
}

/* ─────────────────  Element catalog (vertical slice 1)  ───────────────── */

export type ProfileHint = 'closed-path' | 'open-path' | 'symmetric-half' | 'tileable';

export interface ProfileSlot {
  name: string;
  description: string;
  hint: ProfileHint;
  bbox?: readonly [number, number, number, number];
}

export type ParamSlotKind = 'number' | 'integer' | 'enum';

export interface ParamSlot {
  name: string;
  kind: ParamSlotKind;
  range?: readonly [number, number];
  choices?: readonly string[];
  default: number | string;
}

export type ElementCategory = 'connector' | 'ornament';

export interface ElementGraphRef {
  kind: 'kernel-fn';
  module: string;
  export: string;
}

export interface Element {
  id: string;
  category: ElementCategory;
  graph: ElementGraphRef;
  profileSlots: readonly ProfileSlot[];
  paramSchema: readonly ParamSlot[];
}

export type ProvenanceSource = 'ai' | 'human';

export interface BindingProvenance {
  source: ProvenanceSource;
  aiProvider?: 'anthropic' | 'openai' | 'fal' | 'local';
  aiModel?: string;
  promptHash?: string;
  createdAt: string;
  referenceImageHashes?: readonly string[];
}

export interface ElementBinding {
  elementId: string;
  styleSheetId: string;
  seed: bigint;
  profiles: Readonly<Record<string, string>>;
  params: Readonly<Record<string, number | string>>;
  provenance: BindingProvenance;
}

/** A named axis of cultural tags used to classify and filter architectural elements. */
export type TagAxis = {
  id: string;
  label: string;
  values: { id: string; label: string }[];
};

/** A physical building material with rendering properties and cost metadata. */
export type Material = {
  id: string;
  name: string;
  presetSource?: string;
  referenceImagePath?: string;
  color: string;
  grain: string;
  properties: {
    durability: number;
    cost: number;
    workability: number;
  };
};

/** A decorative motif that can be applied to architectural surfaces. */
export type Ornament = {
  id: string;
  name: string;
  description: string;
  referenceImagePaths: string[];
  pbrTexturePath?: string;
  scenarioWeights: Record<string, number>;
};

/** A conditional assignment rule that maps tag-matched scenarios to materials and ornaments. */
export type Rule = {
  id: string;
  priority: number;
  conditions: {
    scenario?: string;
    tagMatches: Record<string, string>;
  };
  assigns: {
    materialId?: string;
    ornamentIds?: string[];
    weight?: number;
  };
};

/** A historical period within a culture, defining defaults and typology distributions. */
export type Era = {
  id: string;
  name: string;
  dateRange: [number, number];
  defaults: {
    roofType: string;
    proportions: {
      columnSlenderness: number;
      storyHeight: number;
      doorAspect: number;
    };
    palette: string[];
    ornamentDensity: 'sparse' | 'moderate' | 'dense' | 'saturated';
    technique: string;
  };
  typologyMix: Record<string, number>;
  rules: Rule[];
};

/** A named architectural culture composed of eras, materials, ornaments, tag axes, and rules. */
export type Culture = {
  id: string;
  name: string;
  region: string;
  climate: string;
  tagAxes: TagAxis[];
  materials: Material[];
  ornaments: Ornament[];
  rules: Rule[];
  eras: Era[];
};

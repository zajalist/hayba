import type { Material, Ornament, TagAxis, Culture } from '../schema-v2.js';

export const MATERIAL_PRESETS: Material[] = [
  {
    id: 'limestone',
    name: 'Limestone',
    color: '#d4c9a8',
    grain: 'fine, sedimentary bands',
    properties: { durability: 0.65, cost: 0.35, workability: 0.75 },
  },
  {
    id: 'granite',
    name: 'Granite',
    color: '#8a7d72',
    grain: 'coarse crystalline speckle',
    properties: { durability: 0.95, cost: 0.80, workability: 0.25 },
  },
  {
    id: 'sandstone',
    name: 'Sandstone',
    color: '#c8a96e',
    grain: 'gritty, warm-toned bands',
    properties: { durability: 0.55, cost: 0.30, workability: 0.80 },
  },
  {
    id: 'marble',
    name: 'Marble',
    color: '#f0ece4',
    grain: 'smooth with fine veining',
    properties: { durability: 0.70, cost: 0.90, workability: 0.60 },
  },
  {
    id: 'oak',
    name: 'Oak',
    color: '#8b6340',
    grain: 'strong straight grain with rays',
    properties: { durability: 0.70, cost: 0.45, workability: 0.65 },
  },
  {
    id: 'pine',
    name: 'Pine',
    color: '#c49a6c',
    grain: 'soft, resinous with knots',
    properties: { durability: 0.40, cost: 0.20, workability: 0.85 },
  },
  {
    id: 'mudbrick',
    name: 'Mudbrick',
    color: '#b5834a',
    grain: 'rough earthen surface',
    properties: { durability: 0.25, cost: 0.05, workability: 0.90 },
  },
  {
    id: 'fired-brick',
    name: 'Fired Brick',
    color: '#b5522a',
    grain: 'smooth face with mortar joints',
    properties: { durability: 0.75, cost: 0.25, workability: 0.70 },
  },
  {
    id: 'slate',
    name: 'Slate',
    color: '#5a6672',
    grain: 'cleaved flat planes, dark grey',
    properties: { durability: 0.85, cost: 0.50, workability: 0.45 },
  },
  {
    id: 'terracotta',
    name: 'Terracotta',
    color: '#c1622f',
    grain: 'smooth to slightly porous, warm red',
    properties: { durability: 0.55, cost: 0.20, workability: 0.75 },
  },
  {
    id: 'lime-plaster',
    name: 'Lime Plaster',
    color: '#e8e0d0',
    grain: 'smooth or lightly textured finish',
    properties: { durability: 0.35, cost: 0.15, workability: 0.95 },
  },
  {
    id: 'iron',
    name: 'Iron',
    color: '#4a4a4a',
    grain: 'cast or wrought surface with scale',
    properties: { durability: 0.85, cost: 0.70, workability: 0.35 },
  },
];

export const ORNAMENT_PRESETS: Ornament[] = [
  {
    id: 'acanthus-leaf',
    name: 'Acanthus Leaf',
    description: 'Stylised Mediterranean thistle leaf used in Corinthian capitals and friezes.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'interlace-knot',
    name: 'Interlace Knot',
    description: 'Continuous interwoven ribbon forming endless knot patterns.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'dentil',
    name: 'Dentil',
    description: 'Row of small rectangular blocks below a cornice, common in classical orders.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'egg-and-dart',
    name: 'Egg and Dart',
    description: 'Alternating ovoid and dart shapes used on classical mouldings.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'rosette',
    name: 'Rosette',
    description: 'Circular flower-like motif with radiating petals, widely used across cultures.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'palmette',
    name: 'Palmette',
    description: 'Fan-shaped palm frond ornament, common in Near Eastern and Greek friezes.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'meander',
    name: 'Meander',
    description: 'Greek key pattern of continuous right-angled spirals forming a border band.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'guilloche',
    name: 'Guilloche',
    description: 'Braided or twisted rope pattern of two or more interlocking bands.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'fleur-de-lis',
    name: 'Fleur-de-lis',
    description: 'Stylised lily heraldic charge used extensively in Gothic and French architecture.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'quatrefoil',
    name: 'Quatrefoil',
    description: 'Four-lobed Gothic tracery form used in windows and stone screens.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'trefoil',
    name: 'Trefoil',
    description: 'Three-lobed clover shape common in Gothic arches and tracery.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'floral-spray',
    name: 'Floral Spray',
    description: 'Naturalistic bunch of flowers and foliage used in spandrels and panels.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'geometric-arabesque',
    name: 'Geometric Arabesque',
    description: 'Repeating star polygon and interlace pattern from Islamic architectural tradition.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'dragon-scroll',
    name: 'Dragon Scroll',
    description: 'Sinuous dragon silhouette winding through a scrolling cloud or wave band.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'cloud-motif',
    name: 'Cloud Motif',
    description: 'Stylised ruyi-cloud form used in East Asian bracket sets and painted ceilings.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'lotus-pad',
    name: 'Lotus Pad',
    description: 'Inverted lotus petal band used on column bases and bracket capitals in South Asia.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'wave-crest',
    name: 'Wave Crest',
    description: 'Repeating curling wave border evoking ocean movement, used in friezes and tile.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'corbel-head',
    name: 'Corbel Head',
    description: 'Human or animal head carved as a projecting corbel supporting a beam or arch.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'gargoyle-face',
    name: 'Gargoyle Face',
    description: 'Grotesque water-spouting beast face projecting from a parapet or gutter.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
  {
    id: 'chevron-band',
    name: 'Chevron Band',
    description: 'Zigzag band of V-shapes used in Norman and Romanesque arch decoration.',
    referenceImagePaths: [],
    scenarioWeights: {},
  },
];

export const TAG_AXIS_PRESETS: TagAxis[] = [
  {
    id: 'climate',
    label: 'Climate',
    values: [
      { id: 'arid', label: 'Arid' },
      { id: 'temperate', label: 'Temperate' },
      { id: 'alpine', label: 'Alpine' },
      { id: 'coastal', label: 'Coastal' },
    ],
  },
  {
    id: 'terrain',
    label: 'Terrain',
    values: [
      { id: 'lowland', label: 'Lowland' },
      { id: 'highland', label: 'Highland' },
      { id: 'coastal-cliff', label: 'Coastal Cliff' },
    ],
  },
  {
    id: 'wealth',
    label: 'Wealth',
    values: [
      { id: 'peasant', label: 'Peasant' },
      { id: 'merchant', label: 'Merchant' },
      { id: 'noble', label: 'Noble' },
      { id: 'royal', label: 'Royal' },
    ],
  },
  {
    id: 'defensive-posture',
    label: 'Defensive Posture',
    values: [
      { id: 'peaceful', label: 'Peaceful' },
      { id: 'borderland', label: 'Borderland' },
      { id: 'wartime', label: 'Wartime' },
    ],
  },
  {
    id: 'water-access',
    label: 'Water Access',
    values: [
      { id: 'riverine', label: 'Riverine' },
      { id: 'lakeside', label: 'Lakeside' },
      { id: 'dry', label: 'Dry' },
    ],
  },
  {
    id: 'trade',
    label: 'Trade',
    values: [
      { id: 'isolated', label: 'Isolated' },
      { id: 'local', label: 'Local' },
      { id: 'long-distance', label: 'Long-Distance' },
    ],
  },
];

export function seedCulture(args: {
  id: string;
  name: string;
  region: string;
  climate: string;
}): Culture {
  return {
    id: args.id,
    name: args.name,
    region: args.region,
    climate: args.climate,
    tagAxes: structuredClone(TAG_AXIS_PRESETS),
    materials: structuredClone(MATERIAL_PRESETS),
    ornaments: structuredClone(ORNAMENT_PRESETS),
    rules: [],
    eras: [],
  };
}

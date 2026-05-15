/**
 * scrape-gaea-docs.ts
 *
 * Generates knowledge layer JSON files by combining:
 * 1. Gaea docs (docs.gaea.app/llms-full.txt) for node catalog & best practices
 * 2. NODE_CATALOG from swarmhost.ts for parameter details
 * 3. .terrain example files for predecessor/successor enrichment
 * 4. Transcript files for additional node co-occurrence data
 *
 * Run: npx tsx packages/hayba/src/gaea/scripts/scrape-gaea-docs.ts
 */

import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, '..', 'knowledge', 'gaea-docs');
const EXAMPLES_DIR = resolve(__dirname, '..', 'knowledge', 'more_examples');
const ARCHETYPES_PATH = resolve(__dirname, '..', 'knowledge', 'archetypes.json');
const TRANSCRIPTS_DIR = resolve(__dirname, '..', 'transcripts');

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Node Reference ──────────────────────────────────────────────────────────
// Built from docs.gaea.app node catalog + our internal NODE_CATALOG parameters

interface NodeRef {
  category: string;
  description: string;
  ports: { in: string[]; out: string[] };
  parameters: Record<string, { type: string; default: string; range?: string }>;
  tips: string[];
  phase_hint: string;
  typical_predecessors: string[];
  typical_successors: string[];
}

function inferPhaseHint(category: string): string {
  const c = category.toLowerCase();
  if (/primitive|generator|terrain|gradient|noise/.test(c)) return 'base';
  if (/erosion|simulat|weather/.test(c)) return 'simulation';
  if (/filter|modif|transform|surface|cleanup/.test(c)) return 'character';
  if (/color|texture|data|derive/.test(c)) return 'lookdev';
  if (/output|utility|export/.test(c)) return 'utility';
  return 'character';
}

// Full Gaea node catalog from docs.gaea.app + our swarmhost NODE_CATALOG
function buildNodeReference(): Record<string, NodeRef> {
  const nodes: Record<string, NodeRef> = {};

  // === Primitives ===
  nodes['Mountain'] = {
    category: 'primitive', description: 'Generates individual mountain peak terrain with configurable style and bulk',
    ports: { in: [], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' }, Scale: { type: 'float', default: '1.0', range: '0.1-10' }, Height: { type: 'float', default: '0.5', range: '0-10' }, Style: { type: 'enum', default: 'Basic' }, Bulk: { type: 'enum', default: 'Medium' } },
    tips: ['Use Style=Alpine for sharp ridges', 'Combine multiple Mountains with Combine for ranges', 'Use as base shape before erosion'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['MountainRange'] = {
    category: 'primitive', description: 'Creates extended mountain range formations with multiple peaks',
    ports: { in: [], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' }, Scale: { type: 'float', default: '1.0' }, Style: { type: 'enum', default: 'Basic' }, Bulk: { type: 'enum', default: 'Medium' } },
    tips: ['Better than multiple Mountains for natural-looking ranges'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['MountainSide'] = {
    category: 'primitive', description: 'Generates mountain slope terrain for side-view compositions',
    ports: { in: [], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' }, Scale: { type: 'float', default: '1.0' }, Detail: { type: 'float', default: '0.5', range: '0-1' }, Style: { type: 'enum', default: 'Slope' } },
    tips: [], phase_hint: 'base', typical_predecessors: [], typical_successors: [],
  };
  nodes['Ridge'] = {
    category: 'primitive', description: 'Creates ridge formation terrain',
    ports: { in: [], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' }, Height: { type: 'float', default: '0.5', range: '0-10' } },
    tips: [], phase_hint: 'base', typical_predecessors: [], typical_successors: [],
  };
  nodes['Perlin'] = {
    category: 'primitive', description: 'Perlin noise generator for base terrain or detail overlays',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' }, Scale: { type: 'float', default: '1.0', range: '0.01-10' }, Octaves: { type: 'int', default: '8', range: '1-16' } },
    tips: ['Low Scale (0.25) for gentle rolling terrain', 'Use as foundation blended with Mountains'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['MultiFractal'] = {
    category: 'primitive', description: 'Multi-scale fractal noise with FBM, Billowy, and Ridged variants',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' }, Size: { type: 'float', default: '1.0', range: '0.01-10' }, NoiseType: { type: 'enum', default: 'FBM' } },
    tips: ['Ridged creates sharp mountain-like features'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Voronoi'] = {
    category: 'primitive', description: 'Voronoi cell patterns for cracked/tiled terrain',
    ports: { in: [], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' }, Scale: { type: 'float', default: '1.0', range: '0.1-10' }, Jitter: { type: 'float', default: '0.5', range: '0-1' } },
    tips: ['Good for dry lake bed or cracked earth patterns'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Crater'] = {
    category: 'primitive', description: 'Single crater formation',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' }, Style: { type: 'enum', default: 'New' } },
    tips: [], phase_hint: 'base', typical_predecessors: [], typical_successors: [],
  };
  nodes['CraterField'] = {
    category: 'primitive', description: 'Multiple crater generation for volcanic or impact terrain',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' } },
    tips: ['Stack multiple CraterFields with different seeds for variety'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Canyon'] = {
    category: 'primitive', description: 'Canyon formation with configurable style and depth',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' }, Style: { type: 'enum', default: 'Classic' } },
    tips: ['Style=Eroded for natural weathered canyons'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Volcano'] = {
    category: 'primitive', description: 'Volcanic landform creation with caldera',
    ports: { in: [], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' } },
    tips: [], phase_hint: 'base', typical_predecessors: [], typical_successors: [],
  };
  nodes['Island'] = {
    category: 'primitive', description: 'Island landform generation with ocean falloff',
    ports: { in: [], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' } },
    tips: ['Good base for coastal terrains'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Rugged'] = {
    category: 'primitive', description: 'Rugged terrain detail generator',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' } },
    tips: [], phase_hint: 'base', typical_predecessors: [], typical_successors: [],
  };
  nodes['DuneSea'] = {
    category: 'primitive', description: 'Sand dune field generation',
    ports: { in: [], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' } },
    tips: ['Use for desert biome base shapes'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Plates'] = {
    category: 'primitive', description: 'Tectonic plate simulation for continental terrain',
    ports: { in: [], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' } },
    tips: [], phase_hint: 'base', typical_predecessors: [], typical_successors: [],
  };
  nodes['RadialGradient'] = {
    category: 'primitive', description: 'Circular gradient generation',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Height: { type: 'float', default: '1.0', range: '0-1' }, Scale: { type: 'float', default: '1.0', range: '0.1-10' } },
    tips: ['Use as mask for blending center vs edges'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['LinearGradient'] = {
    category: 'primitive', description: 'Linear value gradient',
    ports: { in: [], out: ['Out'] },
    parameters: {},
    tips: ['Use as mask for directional effects'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Hemisphere'] = {
    category: 'primitive', description: 'Hemispherical shape generation',
    ports: { in: [], out: ['Out'] },
    parameters: {},
    tips: ['Good for smooth island bases or dome shapes'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Constant'] = {
    category: 'primitive', description: 'Uniform heightfield value',
    ports: { in: [], out: ['Out'] },
    parameters: {},
    tips: ['Use as input mask or flat base'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Noise'] = {
    category: 'primitive', description: 'Basic procedural noise',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' } },
    tips: [], phase_hint: 'base', typical_predecessors: [], typical_successors: [],
  };
  nodes['Gabor'] = {
    category: 'primitive', description: 'Directional noise generation',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Seed: { type: 'int', default: '0' } },
    tips: [], phase_hint: 'base', typical_predecessors: [], typical_successors: [],
  };
  nodes['Shape'] = {
    category: 'primitive', description: 'Geometric shape generation',
    ports: { in: [], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'base', typical_predecessors: [], typical_successors: [],
  };
  nodes['File'] = {
    category: 'input', description: 'Imports external geometry/terrain/mask files',
    ports: { in: [], out: ['Out'] },
    parameters: { FileName: { type: 'string', default: '' } },
    tips: ['Use to bring in painted zone masks', 'Supports heightmap images and .terrain files'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Draw'] = {
    category: 'primitive', description: 'Manual drawing/painting on heightfield',
    ports: { in: [], out: ['Out'] },
    parameters: {},
    tips: ['Use for road paths or custom feature placement'], phase_hint: 'base',
    typical_predecessors: [], typical_successors: [],
  };

  // === Erosion / Simulation ===
  nodes['Erosion2'] = {
    category: 'simulation', description: 'Advanced hydraulic erosion with sediment transport. Resolution-independent algorithm.',
    ports: { in: ['In', 'Precipitation', 'Mask'], out: ['Out', 'Flow', 'Wear', 'Deposits'] },
    parameters: { Duration: { type: 'float', default: '0.5', range: '0-1' }, Downcutting: { type: 'float', default: '0.5', range: '0-1' }, ErosionScale: { type: 'float', default: '0.5', range: '0-1' }, Seed: { type: 'int', default: '0' } },
    tips: ['Chain multiple with decreasing duration for realism', 'Use Flow output for river mask generation', 'Use Wear output for weathering color masks', 'Enable Deterministic for reproducible results'],
    phase_hint: 'simulation', typical_predecessors: [], typical_successors: [],
  };
  nodes['Erosion'] = {
    category: 'simulation', description: 'Standard erosion simulation',
    ports: { in: ['In', 'Mask'], out: ['Out', 'Flow', 'Wear', 'Deposits'] },
    parameters: { Duration: { type: 'float', default: '0.5', range: '0-1' }, Seed: { type: 'int', default: '0' } },
    tips: ['Erosion2 is generally preferred for new work'], phase_hint: 'simulation',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['EasyErosion'] = {
    category: 'simulation', description: 'Preset-driven simplified erosion with 15 styles',
    ports: { in: ['In'], out: ['Out', 'Flow', 'Wear', 'Deposits'] },
    parameters: { Style: { type: 'enum', default: 'Simple' }, Influence: { type: 'float', default: '0.5', range: '0-1' } },
    tips: ['Quick way to add erosion with tested presets', 'Style=Alpine for mountain terrain'], phase_hint: 'simulation',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Thermal'] = {
    category: 'simulation', description: 'Thermal erosion — simulates gravity-driven material movement on slopes',
    ports: { in: ['In', 'Mask'], out: ['Out'] },
    parameters: {},
    tips: ['Apply before water-based erosion for realistic landslide patterns', 'Creates talus slopes at base of cliffs'], phase_hint: 'simulation',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Thermal2'] = {
    category: 'simulation', description: 'Advanced thermal erosion with more control',
    ports: { in: ['In', 'Mask'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'simulation', typical_predecessors: [], typical_successors: [],
  };
  nodes['ThermalShaper'] = {
    category: 'simulation', description: 'Thermal erosion shaping for slope refinement',
    ports: { in: ['In', 'Intensity'], out: ['Out'] },
    parameters: {},
    tips: ['Good for softening sharp edges after erosion'], phase_hint: 'simulation',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Sediments'] = {
    category: 'simulation', description: 'Sediment deposition simulation',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: ['Apply after erosion to fill valleys with deposited material'], phase_hint: 'simulation',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Crumble'] = {
    category: 'simulation', description: 'Gravity-based crumbling of terrain edges',
    ports: { in: ['In', 'AreaMask'], out: ['Out', 'Wear'] },
    parameters: {},
    tips: [], phase_hint: 'simulation', typical_predecessors: [], typical_successors: [],
  };
  nodes['Anastomosis'] = {
    category: 'simulation', description: 'Stream anastomosis — creates braided channel patterns',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: ['Creates braided river patterns typical of floodplains'], phase_hint: 'simulation',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Lichtenberg'] = {
    category: 'simulation', description: 'Lichtenberg fractal pattern formation — lightning/river branching',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: ['Chain multiple for deeper branching patterns'], phase_hint: 'simulation',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Rivers'] = {
    category: 'simulation', description: 'River network generation',
    ports: { in: ['In'], out: ['Out', 'River'] },
    parameters: {},
    tips: ['Use River output as mask for water placement in UE'], phase_hint: 'simulation',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Lake'] = {
    category: 'simulation', description: 'Lake/water body formation based on terrain depression',
    ports: { in: ['In'], out: ['Out', 'Lake'] },
    parameters: {},
    tips: [], phase_hint: 'simulation', typical_predecessors: [], typical_successors: [],
  };
  nodes['Sea'] = {
    category: 'simulation', description: 'Sea/ocean level generation',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'simulation', typical_predecessors: [], typical_successors: [],
  };
  nodes['Snow'] = {
    category: 'simulation', description: 'Snow coverage simulation with melt and settlement',
    ports: { in: ['In', 'SnowMap', 'MeltMap'], out: ['Out', 'Snow', 'Hard', 'Depth'] },
    parameters: { Duration: { type: 'float', default: '0.5', range: '0-1' }, Intensity: { type: 'float', default: '0.5', range: '0-1' }, SettleThaw: { type: 'float', default: '0.5', range: '0-1' }, MeltType: { type: 'enum', default: 'Uniform' }, Melt: { type: 'float', default: '0.5', range: '0-1' }, SnowLine: { type: 'float', default: '0.0', range: '0-1' }, Seed: { type: 'int', default: '0' } },
    tips: ['Use Snow output as mask for white material in UE', 'SnowLine controls minimum altitude for snow'], phase_hint: 'simulation',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Snowfield'] = {
    category: 'simulation', description: 'Persistent snowfield simulation with directional wind',
    ports: { in: ['In'], out: ['Out', 'Snow', 'Hard', 'Depth'] },
    parameters: { Cascades: { type: 'int', default: '3', range: '1-10' }, Duration: { type: 'float', default: '0.5', range: '0-1' }, Intensity: { type: 'float', default: '0.5', range: '0-1' }, SettleThaw: { type: 'float', default: '0.5', range: '0-1' }, Direction: { type: 'enum', default: 'N' }, Seed: { type: 'int', default: '0' } },
    tips: [], phase_hint: 'simulation', typical_predecessors: [], typical_successors: [],
  };
  nodes['Glacier'] = {
    category: 'simulation', description: 'Glacial erosion simulation',
    ports: { in: ['In', 'Reference'], out: ['Out', 'Snow'] },
    parameters: { Scale: { type: 'float', default: '0.5', range: '0-1' }, Direction: { type: 'float', default: '0', range: '0-360' }, Breakage: { type: 'float', default: '0.5', range: '0-1' }, Seed: { type: 'int', default: '0' } },
    tips: [], phase_hint: 'simulation', typical_predecessors: [], typical_successors: [],
  };
  nodes['Debris'] = {
    category: 'simulation', description: 'Physics-based debris accumulation on slopes',
    ports: { in: ['In', 'Emitter'], out: ['Out', 'ColorIndex', 'Debris'] },
    parameters: { DebrisAmount: { type: 'int', default: '10', range: '1-100' }, Friction: { type: 'float', default: '0.5', range: '0-1' }, Restitution: { type: 'float', default: '0.5', range: '0-1' }, Seed: { type: 'int', default: '0' } },
    tips: [], phase_hint: 'simulation', typical_predecessors: [], typical_successors: [],
  };
  nodes['Trees'] = {
    category: 'simulation', description: 'Tree placement mask driven by geology',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: ['Use output as mask for foliage placement in UE'], phase_hint: 'simulation',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Shrubs'] = {
    category: 'simulation', description: 'Shrub placement mask',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'simulation', typical_predecessors: [], typical_successors: [],
  };
  nodes['Dusting'] = {
    category: 'simulation', description: 'Fine dust/talus deposition',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'simulation', typical_predecessors: [], typical_successors: [],
  };
  nodes['Weathering'] = {
    category: 'simulation', description: 'Surface weathering simulation',
    ports: { in: ['In', 'Height'], out: ['Out'] },
    parameters: { Scale: { type: 'float', default: '0.5', range: '0-1' }, Creep: { type: 'float', default: '0.5', range: '0-1' }, Amount: { type: 'float', default: '0.5', range: '0-1' } },
    tips: [], phase_hint: 'simulation', typical_predecessors: [], typical_successors: [],
  };
  nodes['Slump'] = {
    category: 'simulation', description: 'Terrain slumping/sliding simulation',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'base', typical_predecessors: [], typical_successors: [],
  };
  nodes['Hillify'] = {
    category: 'simulation', description: 'Hill formation refinement',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'simulation', typical_predecessors: [], typical_successors: [],
  };

  // === Modify / Filter ===
  nodes['Adjust'] = {
    category: 'modifier', description: 'General value adjustment with optional auto-leveling',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Autolevel: { type: 'bool', default: 'false' }, Strong: { type: 'bool', default: 'false' }, Shaper: { type: 'float', default: '0.5', range: '0-1' } },
    tips: ['Quick way to normalize terrain values'], phase_hint: 'character',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Autolevel'] = {
    category: 'modifier', description: 'Automatic level normalization — stretches values to full 0-1 range',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: ['Always use before export to maximize heightmap range'], phase_hint: 'character',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Clamp'] = {
    category: 'modifier', description: 'Constrains height values to a specified range',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Min: { type: 'float', default: '0', range: '0-1' }, Max: { type: 'float', default: '1', range: '0-1' } },
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Blur'] = {
    category: 'modifier', description: 'Gaussian blur filtering — softens terrain features',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Radius: { type: 'float', default: '0.1', range: '0-1' } },
    tips: ['Use on masks to soften zone boundaries', 'High radius blurs large-scale features'], phase_hint: 'character',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Sharpen'] = {
    category: 'modifier', description: 'Edge sharpening for terrain detail enhancement',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Fold'] = {
    category: 'modifier', description: 'Wave-based fold simulation with sine/triangle/sawtooth waveforms',
    ports: { in: ['In', 'Folds'], out: ['Out'] },
    parameters: { Waveform: { type: 'enum', default: 'Sine' }, Folds: { type: 'float', default: '0.5', range: '0-1' }, Symmetric: { type: 'bool', default: 'false' } },
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Shaper'] = {
    category: 'modifier', description: 'Shape-based terrain modification',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: ['Use to refine overall terrain silhouette'], phase_hint: 'character',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['SoftClip'] = {
    category: 'modifier', description: 'Soft clipping function — gently limits peak values',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Warp'] = {
    category: 'modifier', description: 'General warping deformation — distorts terrain based on noise or input',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: ['Adds natural irregularity to geometric shapes'], phase_hint: 'character',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Swirl'] = {
    category: 'modifier', description: 'Swirling distortion effect',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Transform'] = {
    category: 'modifier', description: 'Geometric transformation — offset, rotate, scale',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { OffsetX: { type: 'float', default: '0', range: '-1-1' }, OffsetY: { type: 'float', default: '0', range: '-1-1' }, Rotation: { type: 'float', default: '0', range: '0-360' }, ScaleX: { type: 'float', default: '1', range: '0.1-10' }, ScaleY: { type: 'float', default: '1', range: '0.1-10' } },
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Transform3D'] = {
    category: 'modifier', description: '3D transformation with perspective',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Transpose'] = {
    category: 'modifier', description: 'Axis transposition — rotates terrain 90 degrees',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Threshold'] = {
    category: 'modifier', description: 'Binary thresholding — creates hard mask from height values',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Deflate'] = {
    category: 'modifier', description: 'Deflation/compression of terrain values',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Amount: { type: 'float', default: '0.5', range: '0-1' } },
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['GraphicEQ'] = {
    category: 'modifier', description: 'Graphic equalizer curves for frequency-based terrain adjustment',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: ['Fine-tune terrain frequency bands like an audio EQ'], phase_hint: 'character',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Recurve'] = {
    category: 'modifier', description: 'Recursive curve application',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Style: { type: 'enum', default: 'Inward' } },
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Curve'] = {
    category: 'modifier', description: 'Curve-based value remapping',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['SlopeBlur'] = {
    category: 'modifier', description: 'Slope-aware blurring — softens based on terrain slope',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Invert'] = {
    category: 'modifier', description: 'Inverts height values (1-x)',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Distance'] = {
    category: 'modifier', description: 'Distance field generation from terrain features',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Aperture'] = {
    category: 'modifier', description: 'Aperture-based morphological filtering',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };

  // === Surface ===
  nodes['Sandstone'] = {
    category: 'surface', description: 'Sandstone layering effect with stratification',
    ports: { in: ['In'], out: ['Out', 'Layers'] },
    parameters: { Passes: { type: 'int', default: '3', range: '1-10' }, Iterations: { type: 'int', default: '12', range: '1-50' }, Spacing: { type: 'float', default: '0.5', range: '0-1' }, Seed: { type: 'int', default: '0' } },
    tips: ['Creates horizontal layering like real sandstone'], phase_hint: 'character',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Stratify'] = {
    category: 'surface', description: 'Stratification layering',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Mode: { type: 'enum', default: 'Linear' } },
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Terraces'] = {
    category: 'surface', description: 'Terrace formation — creates stepped plateaus',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['FractalTerraces'] = {
    category: 'surface', description: 'Fractal terrace formation with natural variation',
    ports: { in: ['In', 'Modulation'], out: ['Out', 'Layers'] },
    parameters: { Spacing: { type: 'float', default: '0.1', range: '0-1' }, Intensity: { type: 'float', default: '0.5', range: '0-1' }, Seed: { type: 'int', default: '0' } },
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Steps'] = {
    category: 'surface', description: 'Step/terrace formation',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Outcrops'] = {
    category: 'surface', description: 'Rock outcrop simulation',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['RockNoise'] = {
    category: 'surface', description: 'Fine rocky detail noise',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Style: { type: 'enum', default: 'A' } },
    tips: ['Adds fine rocky detail without large-scale distortion'], phase_hint: 'character',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Craggy'] = {
    category: 'surface', description: 'Craggy surface texture',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Roughen'] = {
    category: 'surface', description: 'Surface roughening for natural micro-detail',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };
  nodes['Scree'] = {
    category: 'surface', description: 'Scree slope formation with stones',
    ports: { in: ['In', 'Guide'], out: ['Out', 'Stones'] },
    parameters: { Scale: { type: 'float', default: '0.5', range: '0-1' }, Density: { type: 'int', default: '10', range: '1-100' }, Seed: { type: 'int', default: '0' } },
    tips: [], phase_hint: 'character', typical_predecessors: [], typical_successors: [],
  };

  // === Derive / Data ===
  nodes['TextureBase'] = {
    category: 'derive', description: 'Base texture derivation from terrain shape — foundation for coloring',
    ports: { in: ['In', 'Guide'], out: ['Out'] },
    parameters: { Slope: { type: 'float', default: '0.5', range: '0-1' }, Scale: { type: 'float', default: '0.5', range: '0-1' }, Soil: { type: 'float', default: '0.5', range: '0-1' }, Seed: { type: 'int', default: '0' } },
    tips: ['First step in coloring pipeline — connect to SatMap for color'], phase_hint: 'lookdev',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['SatMap'] = {
    category: 'derive', description: 'Satellite-style color mapping from terrain data',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Enhance: { type: 'enum', default: 'None' }, Rough: { type: 'enum', default: 'Med' }, Bias: { type: 'float', default: '0.5', range: '0-1' }, Reverse: { type: 'bool', default: 'false' } },
    tips: ['Primary color node — use after TextureBase', 'Stack multiple SatMaps with Combine for varied coloring'], phase_hint: 'lookdev',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['SuperColor'] = {
    category: 'derive', description: 'Advanced multi-channel color mapping',
    ports: { in: ['In', 'Texture'], out: ['Out'] },
    parameters: { Texture: { type: 'enum', default: 'Texture' }, Strength: { type: 'float', default: '0.5', range: '0-1' }, Seed: { type: 'int', default: '0' }, Bias: { type: 'float', default: '0.5', range: '0-1' }, Reverse: { type: 'bool', default: 'false' } },
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['ColorErosion'] = {
    category: 'derive', description: 'Erosion-based coloring — tints worn surfaces realistically',
    ports: { in: ['In', 'Height', 'Precipitation'], out: ['Out'] },
    parameters: { TransportDistance: { type: 'float', default: '0.5', range: '0-1' }, SedimentDensity: { type: 'float', default: '0.5', range: '0-1' }, Seed: { type: 'int', default: '0' } },
    tips: ['Apply after terrain shape is finalized'], phase_hint: 'lookdev',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['HSL'] = {
    category: 'derive', description: 'Hue, saturation, lightness color adjustment',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['Tint'] = {
    category: 'derive', description: 'Color tinting overlay',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['WaterColor'] = {
    category: 'derive', description: 'Water-specific coloring for lakes and rivers',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['Splat'] = {
    category: 'derive', description: 'Splat map generation for multi-material terrain rendering',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: ['Use for UE landscape material layer blending'], phase_hint: 'lookdev',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['GroundTexture'] = {
    category: 'derive', description: 'Ground surface texturing',
    ports: { in: ['In', 'Mask'], out: ['Out'] },
    parameters: { Strength: { type: 'float', default: '0.5', range: '0-1' }, Coverage: { type: 'float', default: '0.5', range: '0-1' }, Density: { type: 'float', default: '0.5', range: '0-1' } },
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['Height'] = {
    category: 'derive', description: 'Height value extraction — creates mask based on altitude',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Falloff: { type: 'float', default: '0.5', range: '0-1' } },
    tips: ['Use as mask to apply effects only at certain altitudes'], phase_hint: 'lookdev',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Slope'] = {
    category: 'derive', description: 'Slope angle calculation — creates mask from steepness',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Falloff: { type: 'float', default: '0.5', range: '0-1' } },
    tips: ['Use as mask for cliff vs flat areas'], phase_hint: 'lookdev',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Curvature'] = {
    category: 'derive', description: 'Surface curvature analysis',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Type: { type: 'enum', default: 'Vertical' } },
    tips: ['Use as mask for edge highlighting'], phase_hint: 'lookdev',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Normals'] = {
    category: 'derive', description: 'Surface normal map generation',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['Peaks'] = {
    category: 'derive', description: 'Peak identification mask',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['Flow'] = {
    category: 'derive', description: 'Water flow direction map',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['FlowMap'] = {
    category: 'derive', description: 'Flow map generation for water effects',
    ports: { in: ['In', 'Precipitation'], out: ['Out'] },
    parameters: { FlowLength: { type: 'float', default: '0.5', range: '0-1' }, FlowVolume: { type: 'float', default: '0.5', range: '0-1' }, Seed: { type: 'int', default: '0' } },
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['Occlusion'] = {
    category: 'derive', description: 'Ambient occlusion map generation',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['AO'] = {
    category: 'derive', description: 'Ambient occlusion baking',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['Soil'] = {
    category: 'derive', description: 'Soil distribution mapping based on terrain features',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['RockMap'] = {
    category: 'derive', description: 'Rock distribution mapping',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['Texturizer'] = {
    category: 'derive', description: 'Procedural texture generation',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { Style: { type: 'enum', default: 'A' } },
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };

  // === Utility / Combine ===
  nodes['Combine'] = {
    category: 'utility', description: 'Multi-input blending with 24 blend modes including Add, Multiply, Screen, Overlay',
    ports: { in: ['In', 'Input2', 'Mask'], out: ['Out'] },
    parameters: { Ratio: { type: 'float', default: '0.5', range: '0-1' }, Mode: { type: 'enum', default: 'Add' }, Enhance: { type: 'enum', default: 'None' } },
    tips: ['Drag Out→Out to auto-create a Combine', 'Use Mask input for zone-based blending', 'Mode=Blend with Mask for zone painting workflows'], phase_hint: 'utility',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Mixer'] = {
    category: 'utility', description: 'Advanced blending/mixing of multiple inputs',
    ports: { in: ['In', 'Input2', 'Mask'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'utility', typical_predecessors: [], typical_successors: [],
  };
  nodes['Mask'] = {
    category: 'utility', description: 'Masking operations — isolate areas of terrain',
    ports: { in: ['In', 'Mask'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'utility', typical_predecessors: [], typical_successors: [],
  };
  nodes['Chokepoint'] = {
    category: 'utility', description: 'Connection hub/merge point — simplifies complex graph wiring',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: ['Use to reduce visual clutter in large graphs'], phase_hint: 'utility',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Edge'] = {
    category: 'utility', description: 'Boundary handling — ensures clean terrain edges',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: ['Apply before export to prevent edge artifacts'], phase_hint: 'utility',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Accumulator'] = {
    category: 'utility', description: 'Value accumulation across processing chain',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'utility', typical_predecessors: [], typical_successors: [],
  };
  nodes['Seamless'] = {
    category: 'utility', description: 'Makes terrain tile seamlessly',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'utility', typical_predecessors: [], typical_successors: [],
  };
  nodes['Repeat'] = {
    category: 'utility', description: 'Tile repetition control',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'utility', typical_predecessors: [], typical_successors: [],
  };

  // === Output ===
  nodes['Unreal'] = {
    category: 'output', description: 'Unreal Engine export node — outputs R16 heightmap',
    ports: { in: ['In'], out: ['Out'] },
    parameters: { PortCount: { type: 'int', default: '1' } },
    tips: ['Always the rightmost node', 'Connect terrain heightfield to In', 'PortCount=2+ for multi-output (heightmap + splatmap)'], phase_hint: 'utility',
    typical_predecessors: [], typical_successors: [],
  };
  nodes['Mesher'] = {
    category: 'output', description: 'Mesh generation from heightfield',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'utility', typical_predecessors: [], typical_successors: [],
  };
  nodes['LightX'] = {
    category: 'output', description: 'Advanced lighting/rendering for preview',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'utility', typical_predecessors: [], typical_successors: [],
  };
  nodes['TextureBaker'] = {
    category: 'output', description: 'Bakes terrain texture data to file',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'utility', typical_predecessors: [], typical_successors: [],
  };
  nodes['Finalshape'] = {
    category: 'output', description: 'Final shape output node',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'utility', typical_predecessors: [], typical_successors: [],
  };
  nodes['SnowMask'] = {
    category: 'derive', description: 'Snow coverage mask for export',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };
  nodes['HeightMap'] = {
    category: 'output', description: 'Heightmap output node',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'utility', typical_predecessors: [], typical_successors: [],
  };
  nodes['DirtColor'] = {
    category: 'derive', description: 'Dirt coloring based on terrain features',
    ports: { in: ['In'], out: ['Out'] },
    parameters: {},
    tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [],
  };

  return nodes;
}

// ── Enrichment Pass ──────────────────────────────────────────────────────────

function enrichWithExamples(nodes: Record<string, NodeRef>): void {
  console.log('\n=== Enrichment Pass ===');
  const topologies: string[][] = [];

  // 1. Load archetypes
  if (existsSync(ARCHETYPES_PATH)) {
    const archetypes = JSON.parse(readFileSync(ARCHETYPES_PATH, 'utf-8')) as Array<{ core_topology: string[] }>;
    for (const a of archetypes) topologies.push(a.core_topology);
    console.log(`  Loaded ${archetypes.length} archetype topologies`);
  }

  // 2. Load .terrain examples (parse node types sorted by X position)
  if (existsSync(EXAMPLES_DIR)) {
    for (const file of readdirSync(EXAMPLES_DIR).filter(f => f.endsWith('.terrain'))) {
      try {
        const data = JSON.parse(readFileSync(resolve(EXAMPLES_DIR, file), 'utf-8'));
        let assets = data.Assets;
        if (assets && typeof assets === 'object' && '$values' in assets) assets = assets.$values;
        if (!Array.isArray(assets) || !assets[0]) continue;
        const nodesObj = assets[0].Terrain?.Nodes ?? {};
        const sorted = Object.entries(nodesObj)
          .filter(([k]) => !k.startsWith('$'))
          .map(([, v]) => {
            const obj = v as Record<string, unknown>;
            const t = (obj.$type as string) ?? '';
            const pos = obj.Position as Record<string, number> | undefined;
            return { type: t.split('.').pop()?.split(',')[0] ?? '', x: pos?.X ?? 0 };
          })
          .filter(n => n.type)
          .sort((a, b) => a.x - b.x)
          .map(n => n.type);
        if (sorted.length > 0) topologies.push(sorted);
      } catch { /* skip */ }
    }
    console.log(`  Total topologies (archetypes + examples): ${topologies.length}`);
  }

  // 3. Scan transcripts for node mentions
  if (existsSync(TRANSCRIPTS_DIR)) {
    const nodeNames = Object.keys(nodes);
    for (const file of readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith('.txt'))) {
      try {
        const text = readFileSync(resolve(TRANSCRIPTS_DIR, file), 'utf-8');
        const found: string[] = [];
        for (const name of nodeNames) {
          if (new RegExp(`\\b${name}\\b`, 'i').test(text)) found.push(name);
        }
        if (found.length >= 2) topologies.push(found);
      } catch { /* skip */ }
    }
    console.log(`  Total topologies (+ transcripts): ${topologies.length}`);
  }

  // 4. Build predecessor/successor maps
  const predCounts: Record<string, Record<string, number>> = {};
  const succCounts: Record<string, Record<string, number>> = {};

  for (const topo of topologies) {
    for (let i = 0; i < topo.length; i++) {
      const node = topo[i];
      if (!predCounts[node]) predCounts[node] = {};
      if (!succCounts[node]) succCounts[node] = {};
      if (i > 0) {
        const pred = topo[i - 1];
        predCounts[node][pred] = (predCounts[node][pred] || 0) + 1;
      }
      if (i < topo.length - 1) {
        const succ = topo[i + 1];
        succCounts[node][succ] = (succCounts[node][succ] || 0) + 1;
      }
    }
  }

  // 5. Apply top 5 by frequency
  for (const [name, ref] of Object.entries(nodes)) {
    const preds = predCounts[name] || {};
    ref.typical_predecessors = Object.entries(preds)
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n);
    const succs = succCounts[name] || {};
    ref.typical_successors = Object.entries(succs)
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n);
  }

  console.log(`  Enriched ${Object.keys(nodes).length} nodes`);
}

// ── Best Practices ──────────────────────────────────────────────────────────

function buildBestPractices() {
  return { rules: [
    { id: 'bp-001', category: 'workflow', rule: 'Begin with basic nodes and gradually add more complex nodes as you become comfortable. Experiment with presets before refining.', source: 'docs/using/getting-started' },
    { id: 'bp-002', category: 'workflow', rule: 'Erosion is the primary process through which we turn abstract and geometric shapes into believable terrains.', source: 'docs/using/understanding-erosion' },
    { id: 'bp-003', category: 'simulation', rule: 'Chain erosion strategically: apply multiple erosion passes sequentially with decreasing duration rather than relying on single-pass processing.', source: 'docs/using/understanding-erosion' },
    { id: 'bp-004', category: 'simulation', rule: 'Use selective processing with masks for specific flow control when needing precise major flow lines.', source: 'docs/using/understanding-erosion' },
    { id: 'bp-005', category: 'simulation', rule: 'Erosion is not mandatory as the final step. Modern workflows use LookDev nodes (Canyonizer, Stacks, Anastomosis, Shear) for alternative effects.', source: 'docs/using/understanding-erosion' },
    { id: 'bp-006', category: 'simulation', rule: 'Apply Thermal/Thermal2 simulation before water-based erosion for realistic landslide patterns on slopes.', source: 'docs/reference/simulation' },
    { id: 'bp-007', category: 'organization', rule: 'Use Tabs to separate concerns — split complex graphs across multiple tabs by function: main shape, colors, masks, and exports.', source: 'docs/using/managing-graphs' },
    { id: 'bp-008', category: 'organization', rule: 'Organize related nodes into collapsible Groups with colors and icons to clarify workflow logic.', source: 'docs/using/managing-graphs' },
    { id: 'bp-009', category: 'organization', rule: 'Use Portals to connect nodes across vast gaps without visible connections, reducing clutter.', source: 'docs/using/managing-graphs' },
    { id: 'bp-010', category: 'organization', rule: 'Use Auto Layout (F4) to untangle dense graph areas while preserving logic.', source: 'docs/using/managing-graphs' },
    { id: 'bp-011', category: 'organization', rule: 'Bookmark critical nodes (key generators, export points) for instant navigation in large graphs.', source: 'docs/using/managing-graphs' },
    { id: 'bp-012', category: 'performance', rule: 'Suspend the engine (backtick key) when making multiple edits to avoid long reprocessing.', source: 'docs/using/managing-graphs' },
    { id: 'bp-013', category: 'performance', rule: 'Lock Preview (F key) to pin a specific node and prevent full recalculation when testing upstream changes.', source: 'docs/using/managing-graphs' },
    { id: 'bp-014', category: 'performance', rule: 'Bake heavy/finalized nodes at high resolution to reduce computational load during editing. Resolution options: 1024, 2048 (default), 4096, 8192.', source: 'docs/using/baking-nodes' },
    { id: 'bp-015', category: 'performance', rule: 'Use Build Swarm (close Gaea UI first) for full-resolution builds — the UI takes up large portions of RAM, CPU, and GPU.', source: 'docs/developers' },
    { id: 'bp-016', category: 'performance', rule: 'Enable "Purge Unnecessary Cache During Build" in Options > Build to reduce RAM usage on memory-constrained systems.', source: 'docs/using/build-and-export' },
    { id: 'bp-017', category: 'export', rule: 'Use Build Path Tokens (<FileLocation>, [Filename], [Timestamp], [+++]) for organized, reproducible output paths.', source: 'docs/using/build-and-export' },
    { id: 'bp-018', category: 'export', rule: 'Add Regions to isolate and upscale high-detail areas without rebuilding the entire terrain.', source: 'docs/using/build-and-export' },
    { id: 'bp-019', category: 'export', rule: 'Choose build subdivision based on quality vs speed: None for fast builds, Balanced for standard, Slower for production.', source: 'docs/using/build-and-export' },
    { id: 'bp-020', category: 'lookdev', rule: 'Apply ColorErosion after terrain shape is finalized to tint worn surfaces realistically without altering geometry.', source: 'docs/reference/colorize' },
    { id: 'bp-021', category: 'lookdev', rule: 'Use Normals, Curvature, and Slope nodes as masks to selectively apply effects to specific terrain features.', source: 'docs/reference/derive' },
    { id: 'bp-022', category: 'lookdev', rule: 'Start coloring pipeline with TextureBase → SatMap, then layer additional color nodes with Combine.', source: 'docs/using/colorizing-and-textures' },
    { id: 'bp-023', category: 'workflow', rule: 'Use chained creation shortcodes (m,e2,e2,tb,sm) to rapidly build linear sequences: Mountain→Erosion2→Erosion2→TextureBase→SatMap.', source: 'docs/ui/graph-conveniences' },
    { id: 'bp-024', category: 'workflow', rule: 'Drag output-to-output to auto-insert a Combine node — avoids manual setup.', source: 'docs/ui/graph-conveniences' },
    { id: 'bp-025', category: 'workflow', rule: 'Push nodes with Ctrl+Shift drag to shift them rightward for quick graph reorganization.', source: 'docs/ui/graph-conveniences' },
    { id: 'bp-026', category: 'organization', rule: 'Set correct Underlays on secondary branches (right-click > Use as Underlay or press G) to prevent incorrect terrain display.', source: 'docs/using/managing-graphs' },
    { id: 'bp-027', category: 'performance', rule: 'Avoid modifying nodes upstream of an Underlay — all intermediate nodes rebuild, causing slowdowns at 2K+ resolution.', source: 'docs/using/managing-graphs' },
    { id: 'bp-028', category: 'simulation', rule: 'Erosion2 algorithm is resolution-independent — 512x512 previews match 4K/8K output quality.', source: 'docs/using/understanding-erosion' },
    { id: 'bp-029', category: 'simulation', rule: 'Enable Deterministic option on erosion for reproducible results (slower but identical outputs).', source: 'docs/using/understanding-erosion' },
    { id: 'bp-030', category: 'workflow', rule: 'Combine Warp with primitive shapes (RadialGradient, heightmaps) for realistic detail generation.', source: 'docs/using/understanding-erosion' },
  ]};
}

// ── Workflow Patterns ────────────────────────────────────────────────────────

function buildWorkflowPatterns() {
  return {
    'basic-mountain': {
      nodes: ['Mountain', 'Erosion2', 'Autolevel'],
      connections: [
        { from: 'Mountain', fromPort: 'Out', to: 'Erosion2', toPort: 'In' },
        { from: 'Erosion2', fromPort: 'Out', to: 'Autolevel', toPort: 'In' },
      ],
      description: 'Minimal mountain terrain: generate, erode, normalize',
      when_to_use: 'Simplest possible terrain starting point',
      phase: 'base',
    },
    'erosion-chain': {
      nodes: ['Erosion2', 'ThermalShaper', 'Sediments'],
      connections: [
        { from: 'Erosion2', fromPort: 'Out', to: 'ThermalShaper', toPort: 'In' },
        { from: 'ThermalShaper', fromPort: 'Out', to: 'Sediments', toPort: 'In' },
      ],
      description: 'Standard erosion pipeline: hydraulic → thermal → sediment deposition',
      when_to_use: 'After base shape is established for realistic weathering',
      phase: 'simulation',
    },
    'double-erosion': {
      nodes: ['Erosion2', 'Erosion2'],
      connections: [
        { from: 'Erosion2', fromPort: 'Out', to: 'Erosion2', toPort: 'In' },
      ],
      description: 'Chained erosion: first pass for large gullies, second for ridge softening',
      when_to_use: 'When single erosion pass is insufficient for realism',
      phase: 'simulation',
    },
    'alpine-texture': {
      nodes: ['TextureBase', 'SatMap', 'Snow', 'Combine'],
      connections: [
        { from: 'TextureBase', fromPort: 'Out', to: 'SatMap', toPort: 'In' },
        { from: 'SatMap', fromPort: 'Out', to: 'Combine', toPort: 'In' },
        { from: 'Snow', fromPort: 'Out', to: 'Combine', toPort: 'Input2' },
      ],
      description: 'Alpine coloring: rock texture base + satellite color + snow overlay',
      when_to_use: 'Lookdev phase for alpine/mountain biomes',
      phase: 'lookdev',
    },
    'color-pipeline': {
      nodes: ['TextureBase', 'SatMap', 'SatMap', 'Combine'],
      connections: [
        { from: 'TextureBase', fromPort: 'Out', to: 'SatMap', toPort: 'In' },
      ],
      description: 'Standard coloring: TextureBase → multiple SatMaps → Combine for layered color',
      when_to_use: 'Any terrain that needs realistic coloring',
      phase: 'lookdev',
    },
    'zone-mask-blend': {
      nodes: ['File', 'Blur', 'Combine'],
      connections: [
        { from: 'File', fromPort: 'Out', to: 'Blur', toPort: 'In' },
        { from: 'Blur', fromPort: 'Out', to: 'Combine', toPort: 'Mask' },
      ],
      description: 'Load painted zone mask, blur for soft edges, use as Combine mask',
      when_to_use: 'When using zone painter masks to blend terrain features',
      phase: 'utility',
    },
    'desert-canyon': {
      nodes: ['Canyon', 'Erosion2', 'Sandstone', 'Autolevel'],
      connections: [
        { from: 'Canyon', fromPort: 'Out', to: 'Erosion2', toPort: 'In' },
        { from: 'Erosion2', fromPort: 'Out', to: 'Sandstone', toPort: 'In' },
        { from: 'Sandstone', fromPort: 'Out', to: 'Autolevel', toPort: 'In' },
      ],
      description: 'Desert canyon: canyon base → erosion → sandstone layering',
      when_to_use: 'Desert/arid biome with canyon features',
      phase: 'base',
    },
    'volcanic-island': {
      nodes: ['Island', 'Volcano', 'Combine', 'EasyErosion'],
      connections: [
        { from: 'Island', fromPort: 'Out', to: 'Combine', toPort: 'In' },
        { from: 'Volcano', fromPort: 'Out', to: 'Combine', toPort: 'Input2' },
        { from: 'Combine', fromPort: 'Out', to: 'EasyErosion', toPort: 'In' },
      ],
      description: 'Volcanic island: island base + volcano peak combined, then eroded',
      when_to_use: 'Volcanic island or coastal volcanic terrain',
      phase: 'base',
    },
    'river-valley': {
      nodes: ['Mountain', 'Rivers', 'Erosion2', 'Autolevel'],
      connections: [
        { from: 'Mountain', fromPort: 'Out', to: 'Rivers', toPort: 'In' },
        { from: 'Rivers', fromPort: 'Out', to: 'Erosion2', toPort: 'In' },
        { from: 'Erosion2', fromPort: 'Out', to: 'Autolevel', toPort: 'In' },
      ],
      description: 'River valley: mountain base → river carving → erosion refinement',
      when_to_use: 'Terrain with prominent river features',
      phase: 'simulation',
    },
    'thermal-pools': {
      nodes: ['CraterField', 'Combine', 'Terraces', 'Warp', 'Snow', 'Lake'],
      connections: [],
      description: 'Thermal pools: crater fields → terraced → warped → snow/lake for hot spring landscape',
      when_to_use: 'Exotic geological features like hot springs or geothermal areas',
      phase: 'base',
    },
  };
}

// ── CLI Reference ────────────────────────────────────────────────────────────

function buildCliReference() {
  return { commands: [
    { command: 'Gaea.exe -deactivate', description: 'Release license activation slot', flags: [] },
    { command: 'Gaea-2.x.x.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-', description: 'Unattended silent installation', flags: [
      { flag: '/ALLUSERS', description: 'System-wide installation (requires admin)' },
      { flag: '/CURRENTUSER', description: 'Per-user installation (non-admin)' },
      { flag: '/LOG="filename"', description: 'Save installation log to file' },
      { flag: '/DIR="X:\\PATH"', description: 'Override default installation folder' },
    ]},
    { command: 'Build Swarm (via Build Options > Execute Build)', description: 'Full-resolution terrain build via CLI. Close Gaea UI first to free resources.', flags: [] },
    { command: 'Build Options > Copy Command Line', description: 'Get the exact command-line equivalent of current build settings with fully qualified paths', flags: [] },
  ]};
}

// ── Main ─────────────────────────────────────────────────────────────────────

mkdirSync(OUTPUT_DIR, { recursive: true });

const nodeRef = buildNodeReference();
enrichWithExamples(nodeRef);
writeFileSync(resolve(OUTPUT_DIR, 'node-reference.json'), JSON.stringify(nodeRef, null, 2));
console.log(`\n✓ node-reference.json: ${Object.keys(nodeRef).length} nodes`);

const bestPractices = buildBestPractices();
writeFileSync(resolve(OUTPUT_DIR, 'best-practices.json'), JSON.stringify(bestPractices, null, 2));
console.log(`✓ best-practices.json: ${bestPractices.rules.length} rules`);

const patterns = buildWorkflowPatterns();
writeFileSync(resolve(OUTPUT_DIR, 'workflow-patterns.json'), JSON.stringify(patterns, null, 2));
console.log(`✓ workflow-patterns.json: ${Object.keys(patterns).length} patterns`);

const cli = buildCliReference();
writeFileSync(resolve(OUTPUT_DIR, 'cli-reference.json'), JSON.stringify(cli, null, 2));
console.log(`✓ cli-reference.json: ${cli.commands.length} commands`);

console.log('\nDone!');

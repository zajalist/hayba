// Optimization feedback for material_compile. The UE-side material_compile
// handler returns a `stats` object (instruction counts per shader, texture
// samples, samplers, interpolators) gathered from the FMaterialResource shader
// map after recompilation — the same numbers the Material Editor's Stats panel
// shows. This module turns that raw data into a concise, AI-readable
// optimization briefing with threshold-based hints, so the agent gets feedback
// on shader cost right after it compiles a material via MCP.

/** One shader permutation's instruction count, as reported by UE. */
export interface ShaderInstructionStat {
  /** Shader/permutation description, e.g. "Base pass shader". */
  name: string;
  /** Estimated instruction count for that permutation. */
  instructions: number;
}

/** Raw material stats block as returned by the UE material_compile handler. */
export interface MaterialStats {
  shaders?: ShaderInstructionStat[];
  /** Estimated texture samples (base). */
  texture_samples?: number;
  /** Estimated texture lookups (incl. dependent). */
  texture_lookups?: number;
  /** Virtual texture lookups. */
  virtual_texture_lookups?: number;
  /** Samplers used. */
  samplers?: number;
  /** Sampler budget for the target platform. */
  max_samplers?: number;
  /** Vertex→pixel interpolator scalars used. */
  interpolators_used?: number;
  /** Interpolator scalar budget. */
  interpolators_max?: number;
  /** Shading model / blend mode echoed back for context (optional). */
  shading_model?: string;
  blend_mode?: string;
}

// Soft thresholds for hinting. These are deliberately conservative, generic
// rules of thumb for a typical opaque PBR surface — they nudge, they don't gate.
const INSTR_WARN = 200;   // "getting heavy"
const INSTR_HIGH = 350;   // "expensive — consider simplifying"
const SAMPLES_WARN = 8;   // many texture fetches → bandwidth-bound

/** The peak instruction count across all reported shader permutations. */
export function maxInstructions(stats: MaterialStats): number {
  const shaders = stats.shaders ?? [];
  return shaders.reduce((m, s) => Math.max(m, s.instructions ?? 0), 0);
}

/**
 * Build a human/AI-readable optimization-feedback block from material stats.
 * Returns null when there is nothing useful to report (no stats present), so
 * callers can omit the block entirely for older UE builds.
 */
export function formatOptimizationFeedback(stats: MaterialStats | undefined | null): string | null {
  if (!stats || typeof stats !== 'object') return null;
  const shaders = Array.isArray(stats.shaders) ? stats.shaders : [];
  const hasAnything =
    shaders.length > 0 ||
    typeof stats.texture_samples === 'number' ||
    typeof stats.samplers === 'number' ||
    typeof stats.interpolators_used === 'number';
  if (!hasAnything) return null;

  const lines: string[] = ['OPTIMIZATION FEEDBACK (post-compile shader stats)'];

  if (shaders.length > 0) {
    const peak = maxInstructions(stats);
    lines.push(`  Instructions (peak: ${peak}):`);
    for (const s of shaders) {
      lines.push(`    - ${s.name}: ${s.instructions}`);
    }
  }

  const t = stats.texture_samples;
  const tl = stats.texture_lookups;
  if (typeof t === 'number') {
    const lookupPart = typeof tl === 'number' && tl !== t ? ` (${tl} lookups incl. dependent)` : '';
    lines.push(`  Texture samples: ${t}${lookupPart}`);
  }
  if (typeof stats.virtual_texture_lookups === 'number' && stats.virtual_texture_lookups > 0) {
    lines.push(`  Virtual texture lookups: ${stats.virtual_texture_lookups}`);
  }
  if (typeof stats.samplers === 'number') {
    const budget = typeof stats.max_samplers === 'number' ? `/${stats.max_samplers}` : '';
    lines.push(`  Samplers: ${stats.samplers}${budget}`);
  }
  if (typeof stats.interpolators_used === 'number') {
    const budget = typeof stats.interpolators_max === 'number' ? `/${stats.interpolators_max}` : '';
    lines.push(`  Interpolator scalars: ${stats.interpolators_used}${budget}`);
  }

  const hints = buildHints(stats);
  if (hints.length > 0) {
    lines.push('  Hints:');
    for (const h of hints) lines.push(`    - ${h}`);
  }

  return lines.join('\n');
}

/** Threshold-based, generic optimization hints derived from the stats. */
function buildHints(stats: MaterialStats): string[] {
  const hints: string[] = [];
  const peak = maxInstructions(stats);

  if (peak >= INSTR_HIGH) {
    hints.push(`Peak instruction count is high (${peak} >= ${INSTR_HIGH}). Consider baking constant sub-graphs, reducing math nodes, or moving work to a material instance/parameters.`);
  } else if (peak >= INSTR_WARN) {
    hints.push(`Instruction count is getting heavy (${peak} >= ${INSTR_WARN}). Watch added math/noise nodes on this material.`);
  }

  const t = stats.texture_samples;
  if (typeof t === 'number' && t >= SAMPLES_WARN) {
    hints.push(`${t} texture samples — texture fetches dominate cost here; consider packing channels (ORM/mask atlases) to cut samples.`);
  }

  if (
    typeof stats.samplers === 'number' &&
    typeof stats.max_samplers === 'number' &&
    stats.max_samplers > 0 &&
    stats.samplers >= stats.max_samplers
  ) {
    hints.push(`Sampler budget reached (${stats.samplers}/${stats.max_samplers}). Switch some textures to "Shared: Wrap/Clamp" sampler source to free dedicated samplers.`);
  }

  if (
    typeof stats.interpolators_used === 'number' &&
    typeof stats.interpolators_max === 'number' &&
    stats.interpolators_max > 0 &&
    stats.interpolators_used >= stats.interpolators_max
  ) {
    hints.push(`Interpolator budget reached (${stats.interpolators_used}/${stats.interpolators_max}). Reduce custom UVs / vertex-interpolated data.`);
  }

  return hints;
}

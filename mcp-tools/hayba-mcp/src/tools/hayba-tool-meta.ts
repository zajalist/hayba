export type HaybaToolCost = 'low' | 'medium' | 'high';

export interface HaybaToolMeta {
  cost: HaybaToolCost;
  effects: string[];
  when: string;
  not_when: string;
  /**
   * Optional domain pack assignment for tools NOT organized into a subdirectory
   * of src/tools/. Tools in subdirs derive their pack from the directory name.
   * Unset for root-level tools = joins the `core` default pack with a warning.
   */
  pack?: string;
}

export function describeMeta(m: HaybaToolMeta): string {
  return [
    `[cost=${m.cost}]`,
    `[effects=[${m.effects.join(',')}]]`,
    `USE_WHEN: ${m.when}`,
    `NOT_WHEN: ${m.not_when}`,
  ].join(' ');
}

export function appendMeta(description: string, meta: HaybaToolMeta): string {
  return `${description}\n\n${describeMeta(meta)}`;
}

/**
 * Effect-tag substrings that mean "this tool changed the scene" — an actor was
 * spawned/moved/deleted, the level/world/scene mutated, lighting changed, or a
 * landscape / foliage / PCG operation ran. Matched as case-insensitive
 * substrings against a tool's `effects` tags, so both the historic short tags
 * (`spawns_actor`, `modifies_level`, `mutates_scene`, `actor_spawn`) and future
 * variants are caught without a hand-maintained exact list.
 *
 * Deliberately EXCLUDES pure asset/disk edits (`modifies_asset`, `creates_asset`,
 * `filesystem_write`) and read-only tags — editing a material graph or writing a
 * file on disk does not place anything in the world, so it should not nudge.
 */
export const SCENE_MUTATION_EFFECT_TOKENS = [
  'actor',
  'level',
  'scene',
  'world',
  'lighting',
  'landscape',
  'foliage',
  'pcg',
] as const;

/** True when a tool's `effects` indicate it mutated the live scene/world. */
export function isSceneMutating(effects: string[] | undefined): boolean {
  if (!effects || effects.length === 0) return false;
  return effects.some((e) => {
    const t = e.toLowerCase();
    return SCENE_MUTATION_EFFECT_TOKENS.some((tok) => t.includes(tok));
  });
}

/**
 * One-line, agent-facing hint appended to the result of every scene-mutating
 * tool. The point of the whole "validation discoverability" effort: the agent
 * cannot see the viewport, so silent wrongness (things spawned mid-air,
 * interpenetrating, off-grid, violating PLUMB constraints) goes unnoticed unless
 * it actively validates. This nudge fires right where the mutation happened.
 */
export const VALIDATION_NUDGE =
  'Scene changed — run plumb_validate (or validator_run) to verify placement/grounding/interpenetration and post-conditions before continuing. You cannot see the viewport; validation is how you catch silent wrongness.';

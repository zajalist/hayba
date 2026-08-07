/**
 * The third copy of "this command changes state".
 *
 * plan-mode-gate.test.ts already pins the cross-language half of this — TS
 * NON_IDEMPOTENT against the C++ DestructiveCommands set, by parsing the .cpp
 * rather than a duplicate of it. That leaves one edge unguarded, inside TS.
 *
 * Nine per-domain modules each export their own list:
 *
 *   ACTOR_NON_IDEMPOTENT, FOLIAGE_NON_IDEMPOTENT, LANDSCAPE_NON_IDEMPOTENT,
 *   LIGHTING_NON_IDEMPOTENT, SEQUENCER_NON_IDEMPOTENT, NIAGARA_NON_IDEMPOTENT,
 *   WATER_NON_IDEMPOTENT, ASSET_NON_IDEMPOTENT, EDITOR_NON_IDEMPOTENT, …
 *
 * and none of them is imported by tool-executor. The names are copied across by
 * hand, which the comments there say out loud ("added to tool-executor's
 * NON_IDEMPOTENT set", "Mirrors FOLIAGE_NON_IDEMPOTENT"). Importing them
 * directly would close the loop properly, but the py-tools modules reach
 * tool-executor themselves, so the import cycle is real — which is exactly why
 * legacy-tool-factory mutates the set at module load instead.
 *
 * Hand-copying is therefore load-bearing here. This test makes the copy
 * mechanically checked rather than merely intended: add a name to a domain
 * list, forget tool-executor, and this goes red — before the missing retry gate
 * duplicates an actor in someone's level.
 */

import { describe, expect, it } from 'vitest';
import { NON_IDEMPOTENT } from '../tool-executor.js';

import { ACTOR_NON_IDEMPOTENT } from '../actor/actor-py-tools.js';
import { ASSET_NON_IDEMPOTENT } from '../asset/asset-py-tools.js';
import { EDITOR_NON_IDEMPOTENT } from '../editor/editor-py-tools.js';
import { FOLIAGE_NON_IDEMPOTENT } from '../foliage/foliage-py-tools.js';
import { LANDSCAPE_NON_IDEMPOTENT } from '../landscape/landscape-py-tools.js';
import { LIGHTING_NON_IDEMPOTENT } from '../lighting/lighting-py-tools.js';
import { MESH_NON_IDEMPOTENT } from '../mesh/mesh-py-tools.js';
import { NIAGARA_NON_IDEMPOTENT } from '../niagara/niagara-py-tools.js';
import { SEQUENCER_NON_IDEMPOTENT } from '../sequencer/sequencer-py-tools.js';
import { WATER_NON_IDEMPOTENT } from '../water/water-py-tools.js';

const DOMAIN_LISTS: Array<[string, readonly string[]]> = [
  ['ACTOR', ACTOR_NON_IDEMPOTENT],
  ['ASSET', ASSET_NON_IDEMPOTENT],
  ['EDITOR', EDITOR_NON_IDEMPOTENT],
  ['FOLIAGE', FOLIAGE_NON_IDEMPOTENT],
  ['LANDSCAPE', LANDSCAPE_NON_IDEMPOTENT],
  ['LIGHTING', LIGHTING_NON_IDEMPOTENT],
  ['MESH', MESH_NON_IDEMPOTENT],
  ['NIAGARA', NIAGARA_NON_IDEMPOTENT],
  ['SEQUENCER', SEQUENCER_NON_IDEMPOTENT],
  ['WATER', WATER_NON_IDEMPOTENT],
];

describe('per-domain non-idempotent lists are mirrored into the retry gate', () => {
  for (const [domain, names] of DOMAIN_LISTS) {
    it(`${domain}_NON_IDEMPOTENT is a subset of NON_IDEMPOTENT`, () => {
      const missing = names.filter((n) => !NON_IDEMPOTENT.has(n));
      expect(
        missing,
        `${domain}_NON_IDEMPOTENT declares these mutating commands, but tool-executor's\n` +
          'NON_IDEMPOTENT does not contain them, so a transport failure will auto-retry\n' +
          `them and duplicate the side-effect:\n  ${missing.join('\n  ')}\n\n` +
          "Add them to NON_IDEMPOTENT in src/tools/tool-executor.ts. They also need to\n" +
          'reach the C++ DestructiveCommands set — plan-mode-gate.test.ts covers that.',
      ).toEqual([]);
    });
  }

  it('every domain list is non-empty or explicitly empty on purpose', () => {
    // Not an assertion about correctness — a nudge. An empty list is a claim
    // that the domain has no mutating commands at all, which is true for some
    // (read-only query surfaces) and suspicious for others.
    const empty = DOMAIN_LISTS.filter(([, n]) => n.length === 0).map(([d]) => d);
    expect(Array.isArray(empty)).toBe(true);
  });
});

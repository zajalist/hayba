// The master NON_IDEMPOTENT set must contain every per-domain set.
//
// `executeCommand` retries a command once on transport failure — unless it is
// in `NON_IDEMPOTENT`, because re-firing a spawn or a delete executes it
// twice. The master set is a hand-maintained list, and each tool domain
// separately exports its own `*_NON_IDEMPOTENT` list which the master merely
// *cites in a comment*:
//
//     // Foliage-domain factory tools (Wave 3 Task 2) — see foliage-py-tools.ts
//     // FOLIAGE_NON_IDEMPOTENT (asset-create / append / delete).
//     'foliage_type_create',
//
// So the truth is copied by hand across a dozen files, and nothing checks the
// copy. Add a command to a domain list, forget the master, and it silently
// becomes retry-eligible: on a flaky connection the actor spawns twice, the
// instances append twice, and the second call succeeds so nothing reports an
// error. The domain lists were found to have tests but no production caller,
// which is exactly the shape of a check nobody wired up.
//
// This is the wiring. It is a test rather than a runtime import because the
// domain modules sit downstream of the executor, and importing them back into
// it to fix a bookkeeping problem would be the wrong direction for a cycle.

import { describe, it, expect } from 'vitest';
import { NON_IDEMPOTENT } from './tool-executor.js';

import { ACTOR_NON_IDEMPOTENT } from './actor/actor-py-tools.js';
import { ASSET_NON_IDEMPOTENT } from './asset/asset-py-tools.js';
import { AUDIO_NON_IDEMPOTENT_COMMANDS } from './audio/audio-tools.js';
import { EDITOR_NON_IDEMPOTENT } from './editor/editor-py-tools.js';
import { FOLIAGE_NON_IDEMPOTENT } from './foliage/foliage-py-tools.js';
import { LANDSCAPE_NON_IDEMPOTENT } from './landscape/landscape-py-tools.js';
import { LIGHTING_NON_IDEMPOTENT } from './lighting/lighting-py-tools.js';
import { MESH_NON_IDEMPOTENT } from './mesh/mesh-py-tools.js';
import { NIAGARA_NON_IDEMPOTENT } from './niagara/niagara-py-tools.js';
import { SEQUENCER_NON_IDEMPOTENT } from './sequencer/sequencer-py-tools.js';
import { WATER_NON_IDEMPOTENT } from './water/water-py-tools.js';

const DOMAINS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['ACTOR_NON_IDEMPOTENT', ACTOR_NON_IDEMPOTENT],
  ['ASSET_NON_IDEMPOTENT', ASSET_NON_IDEMPOTENT],
  ['AUDIO_NON_IDEMPOTENT_COMMANDS', AUDIO_NON_IDEMPOTENT_COMMANDS],
  ['EDITOR_NON_IDEMPOTENT', EDITOR_NON_IDEMPOTENT],
  ['FOLIAGE_NON_IDEMPOTENT', FOLIAGE_NON_IDEMPOTENT],
  ['LANDSCAPE_NON_IDEMPOTENT', LANDSCAPE_NON_IDEMPOTENT],
  ['LIGHTING_NON_IDEMPOTENT', LIGHTING_NON_IDEMPOTENT],
  ['MESH_NON_IDEMPOTENT', MESH_NON_IDEMPOTENT],
  ['NIAGARA_NON_IDEMPOTENT', NIAGARA_NON_IDEMPOTENT],
  ['SEQUENCER_NON_IDEMPOTENT', SEQUENCER_NON_IDEMPOTENT],
  ['WATER_NON_IDEMPOTENT', WATER_NON_IDEMPOTENT],
];

describe('every domain non-idempotent list is covered by the master set', () => {
  for (const [name, list] of DOMAINS) {
    it(`${name} (${list.length}) is fully contained in NON_IDEMPOTENT`, () => {
      const missing = list.filter((cmd) => !NON_IDEMPOTENT.has(cmd));
      // Named so a failure says which command would be double-executed.
      expect(missing, `not retry-guarded: ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('covers every domain list that exists', () => {
    // A new domain that exports its own list and is not added above would be
    // unguarded and unnoticed — the same gap one level up. This pins the count
    // so adding a domain forces a decision here.
    expect(DOMAINS).toHaveLength(11);
  });

  it('the master set is not trivially empty', () => {
    expect(NON_IDEMPOTENT.size).toBeGreaterThan(30);
  });
});

// `effects` used to be derived from IDEMPOTENCY, which is a different question
// from whether a command changes anything.
//
// `actor_set_visibility` is idempotent — setting the same visibility twice is
// harmless — and it still mutates the scene. Deriving effects from idempotency
// gave it `effects: []`, which put it outside the evidence contract entirely:
// it could answer `ok` having done nothing and no check would notice. Twenty-
// nine tools were in that state.
//
// The second half: `isSceneMutating` matches a fixed token list, and the old
// code emitted the generic `mutates_state`, which matches none of it. So no
// legacy tool ever received the validation nudge — including `actor_spawn`.

import { describe, it, expect } from 'vitest';
import { isMutatingLegacy, isNonIdempotentLegacy } from './legacy-tool-factory.js';
import { isSceneMutating } from './hayba-tool-meta.js';

describe('mutation is a wider question than idempotency', () => {
  it('counts an idempotent write as mutating', () => {
    expect(isNonIdempotentLegacy('actor_set_visibility')).toBe(false);
    expect(isMutatingLegacy('actor_set_visibility')).toBe(true);
  });

  it('is a superset of non-idempotent', () => {
    for (const name of ['actor_spawn', 'asset_import', 'actor_delete', 'data_set']) {
      if (isNonIdempotentLegacy(name)) expect(isMutatingLegacy(name)).toBe(true);
    }
  });

  it('leaves reads alone', () => {
    // The negative half matters most: declaring effects on a read-only tool
    // would put it under the evidence contract and warn on healthy responses.
    for (const name of ['actor_list', 'asset_exists', 'level_get_info', 'editor_get_state']) {
      expect(isMutatingLegacy(name)).toBe(false);
    }
  });

  it('does not treat a word merely containing a verb as a write', () => {
    // `_set_` as a whole word, not "asset" or "offset".
    expect(isMutatingLegacy('asset_list')).toBe(false);
    expect(isMutatingLegacy('actor_get_offset')).toBe(false);
  });
});

describe('the effect token has to match what reads it', () => {
  it('names a domain the nudge predicate recognises', () => {
    // The old generic `mutates_state` matched none of SCENE_MUTATION_EFFECT_TOKENS,
    // so the nudge never fired for any legacy tool.
    expect(isSceneMutating(['mutates_state'])).toBe(false);
    expect(isSceneMutating(['mutates_actor'])).toBe(true);
    expect(isSceneMutating(['modifies_level'])).toBe(true);
  });

  it('does not claim an asset edit is a scene mutation', () => {
    // Editing a Blueprint's defaults changes an asset on disk, not the live
    // world. It belongs under the evidence contract but not the scene nudge.
    expect(isSceneMutating(['modifies_asset'])).toBe(false);
  });
});

// grammar-guards.ts — wires expandGrammar's GuardFn to the real PLUMB constraint
// evaluation path (evaluate.ts / primitives.ts). Kept separate from grammar.ts
// so grammar.ts stays pure (no store/fs imports).
//
// In a dry-run (no UE scene), most geometry primitives (max_straight_run,
// presence, …) will return SKIP from evalConstraint because they need a baked
// profile or scene context. That is EXPECTED — the brief requires honesty here.
// The solver's fallback logic is tested separately with mock GuardFns.

import type { GuardFn } from './grammar.js';
import type { EmitOp } from './contracts.js';
import type { Symbol } from './contracts.js';
import { loadConstraints } from './constraint-store.js';
import { primitivesById, resolveHard } from './primitives.js';
import { getProfile } from './profile-store.js';
import type { InstanceState, SceneContext } from './contracts.js';

export interface MakeGuardFnOptions {
  /** Optional scene context (for in-engine use). In dry-run, pass nothing. */
  scene?: SceneContext;
}

/**
 * Returns a GuardFn backed by the real PLUMB constraint store + primitives.
 *
 * For each guard id:
 *  - Looks up the constraint by id in the loaded library.
 *  - If not found → SKIP (no effect on hardFail / softFails).
 *  - Evaluates the constraint's primitive via the existing evalConstraint path.
 *  - SKIP and PASS never contribute to failure.
 *  - hardFail = true if ANY HARD constraint evaluates to FAIL.
 *  - softFails = ids of SOFT constraints that FAIL.
 *
 * DRY-RUN NOTE: Without a real scene/profile, most geometry primitives self-skip.
 * This means dry-run will not reject productions that need geometry checks.
 * That is intentional — do NOT fabricate scene data to force rejections.
 */
export function makeGuardFn(opts?: MakeGuardFnOptions): GuardFn {
  return function guardFn(
    guardIds: string[],
    _ops: EmitOp[],
    sym: Symbol,
  ): { hardFail: boolean; softFails: string[] } {
    if (!guardIds.length) return { hardFail: false, softFails: [] };

    const constraints = loadConstraints();
    const prims = primitivesById();

    // Build a minimal InstanceState from the symbol so evalConstraint has
    // something to work with. In dry-run this mostly self-skips.
    const inst: InstanceState = {
      object: sym.kind,
      asset: typeof sym.attrs['asset'] === 'string' ? sym.attrs['asset'] : undefined,
      tags: Object.fromEntries(
        Object.entries(sym.attrs)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => [k, v as string]),
      ),
      transform: {
        pos: [0, 0, 0],
        quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    };

    const scene: SceneContext = opts?.scene ?? { instances: [inst] };

    let hardFail = false;
    const softFails: string[] = [];

    for (const gid of guardIds) {
      const c = constraints.find(x => x.id === gid);
      if (!c) continue; // unknown id → SKIP

      const prim = prims.get(c.primitive);
      if (!prim) continue; // unknown primitive → SKIP

      const profile = inst.asset ? getProfile(inst.asset) : null;
      const out = prim.evaluate({ constraint: c, instance: inst, profile, scene });
      if (out.skip) continue; // no scene/profile data → SKIP

      const ok = out.value_m >= 0;
      if (ok) continue; // PASS → no failure

      // FAIL — determine hard/soft
      const locked = prim.qualitative && (profile?.provenance?.locked ?? []).some(f => {
        if (prim.id === 'facing') return f === 'semantics.front';
        if (prim.id === 'affordance_clear') return f === `affordance:${c.params.affordance}`;
        return false;
      });
      const hard = resolveHard(prim, c, locked);
      if (hard) {
        hardFail = true;
      } else {
        softFails.push(gid);
      }
    }

    return { hardFail, softFails };
  };
}

import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import { runUePythonJson, pyStr } from '../ue-python.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['mutates_scene', 'gpu_load', 'wait'],
  when: 'after editing a PCG graph, to regenerate an actor AND read back instance counts in ONE call — PCGComponent.generate is async, so a plain generate reads 0 instances in the same call. GROUND TRUTH is result.ism[] ({mesh,count} per ISM) — trust this over pcg_read_node_output (a possibly-stale inspection cache). result.freshness {changed,before,after} proves the counts are from THIS cook, not a prior run. idle.timedOut:["pcg"] is EXPECTED/BENIGN for PCGEx async chains and does NOT mean the cook failed (see idle_note); when result.ism is non-empty the cook succeeded regardless of the pcg idle timeout',
  not_when: 'you only want to read existing instances without regenerating — use pcg_inspect_instances',
};

export const schema = z.object({
  actor: z.string().min(1).describe('Label or path of the actor owning the PCGComponent to cook'),
  timeout_s: z.number().int().min(1).max(600).optional().default(120)
    .describe('Hard timeout waiting for the PCG graph to settle'),
});
export type PcgCookAndWaitParams = z.infer<typeof schema>;

function resolveActorAndGenerateScript(actorRef: string): string {
  return [
    `_actor_ref = ${pyStr(actorRef)}`,
    'try:',
    '    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
    '    target = None',
    '    for a in eas.get_all_level_actors():',
    '        try:',
    '            if a.get_actor_label() == _actor_ref or a.get_path_name() == _actor_ref:',
    '                target = a; break',
    '        except Exception: pass',
    '    if target is None: raise Exception("actor not found: %s" % _actor_ref)',
    '    comps = list(target.get_components_by_class(unreal.PCGComponent))',
    '    if not comps: raise Exception("actor has no PCGComponent: %s" % _actor_ref)',
    '    for c in comps:',
    '        done = False',
    '        for attempt in ("generate", "generate_local", "regenerate_in_editor"):',
    '            fn = getattr(c, attempt, None)',
    '            if fn is None: continue',
    '            try:',
    '                fn(True) if attempt != "regenerate_in_editor" else fn()',
    '                done = True; break',
    '            except Exception: pass',
    '        if not done: raise Exception("generate failed on component")',
    '    _emit({"ok": True, "actor_path": target.get_path_name(), "components": len(comps)})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

function inspectScript(actorRef: string): string {
  return [
    `_actor_ref = ${pyStr(actorRef)}`,
    'try:',
    '    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
    '    target = None',
    '    for a in eas.get_all_level_actors():',
    '        try:',
    '            if a.get_actor_label() == _actor_ref or a.get_path_name() == _actor_ref:',
    '                target = a; break',
    '        except Exception: pass',
    '    if target is None: raise Exception("actor not found: %s" % _actor_ref)',
    '    out = []',
    '    for comp in target.get_components_by_class(unreal.InstancedStaticMeshComponent):',
    '        mesh = comp.static_mesh',
    '        out.append({"mesh": (mesh.get_path_name() if mesh else None), "count": comp.get_instance_count()})',
    '    _emit({"ok": True, "actor": target.get_actor_label(), "ism": out, "total": sum(x["count"] for x in out)})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export async function pcgCookAndWaitHandler(params: PcgCookAndWaitParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  const { actor, timeout_s } = parsed.data;
  try {
    // 0. Snapshot the ISM instance count BEFORE regenerating so we can prove the
    //    counts we read back are from THIS cook, not a stale prior run (§3c).
    //    A pre-cook read failure is non-fatal — freshness just goes unknown.
    let before: number | null = null;
    try {
      const pre = await runUePythonJson<{ ok?: boolean; total?: number }>(inspectScript(actor), 30_000);
      before = typeof pre?.total === 'number' ? pre.total : null;
    } catch { /* freshness snapshot is best-effort */ }

    // 1. Trigger regeneration and resolve the actor's full path.
    const gen = await runUePythonJson<{ ok?: boolean; actor_path?: string; error?: string }>(
      resolveActorAndGenerateScript(actor), 30_000,
    );
    if (!gen.ok || !gen.actor_path) {
      return { content: [{ type: 'text' as const, text: `pcg_cook_and_wait: generate failed: ${gen.error ?? 'unknown'}` }], isError: true };
    }

    // 2. Block on the PCG subsystem settling for THIS actor (not world_tick).
    const idle = await executeCommand('wait_for_idle', {
      subsystems: ['pcg'],
      pcg_actors: [gen.actor_path],
      timeout_s,
    }, { timeout: timeout_s * 1000 + 5000 });

    // 3. Read back the resulting instance counts.
    const counts = await runUePythonJson<{ ok?: boolean; total?: number; ism?: unknown[]; error?: string }>(
      inspectScript(actor), 30_000,
    );

    // 4. Hard-fail on a zero-instance cook. A PCG generate that settles clean
    //    but produces NO instances is almost always a broken graph (mesh never
    //    bound to the spawner, or the surface source emitted no points) — NOT a
    //    success. Silent success on empty output is the trap that hides the
    //    single most common scatter failure, so surface it as ok:false.
    const total = typeof counts?.total === 'number' ? counts.total : 0;
    const ismCount = Array.isArray(counts?.ism) ? counts.ism.length : 0;

    // Freshness signal (§3c): compare the pre-cook snapshot to the post-cook read
    // so the agent can trust the numbers are from THIS cook without the diff trick.
    const after = typeof counts?.total === 'number' ? counts.total : null;
    const freshness = {
      before,
      after,
      // `changed` proves this cook moved the numbers. `null` before = snapshot
      // unavailable, so freshness is unknown (not a claim of staleness).
      changed: before === null || after === null ? null : before !== after,
      note:
        'result.ism[] is the AUTHORITATIVE post-cook count. `changed:true` proves it reflects THIS cook; `changed:false` means the count matched the prior run (identical output or async tail not yet settled); `changed:null` means the pre-cook snapshot was unavailable.',
    };

    // §3b — a PCGEx async chain frequently leaves the pcg subsystem reporting a
    // benign idle-timeout AFTER the ISM instances are already spawned and correct.
    // A benign timeout must NOT flip the tool to isError when result.ism is
    // present and non-empty: distinguish "settled, async tail still ticking" from
    // "genuinely still cooking (produced nothing)".
    const idleObj = (idle && typeof idle === 'object') ? (idle as Record<string, unknown>) : {};
    const pcgTimedOut = Array.isArray(idleObj.timedOut) && (idleObj.timedOut as unknown[]).includes('pcg');
    const ismAuthoritative = total > 0 && ismCount > 0;
    const idle_note = pcgTimedOut
      ? (ismAuthoritative
        ? 'BENIGN: idle.timedOut for "pcg" is EXPECTED for PCGEx async chains. result.ism[] is present and non-empty, so the cook SUCCEEDED — the async tail is still ticking but the instances are settled. Do NOT treat this timeout as a failure.'
        : 'idle.timedOut for "pcg" AND result.ism is empty — this cook may be genuinely still cooking or the graph produced nothing. Treated as failure below only because of the zero-instance result.')
      : 'pcg subsystem settled cleanly within the timeout.';

    // 4. Hard-fail on a zero-instance cook. A PCG generate that settles clean
    //    but produces NO instances is almost always a broken graph (mesh never
    //    bound to the spawner, or the surface source emitted no points) — NOT a
    //    success. Silent success on empty output is the trap that hides the
    //    single most common scatter failure, so surface it as ok:false.
    //    NOTE: this fires ONLY on genuine zero output — a benign pcg idle-timeout
    //    with a non-empty result.ism is a SUCCESS (§3b), not a failure.
    if (!ismAuthoritative) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: 'PCG generated 0 instances — check mesh binding (StaticMeshSpawner) / surface source. The graph cooked cleanly but produced no instances.',
            cook: gen,
            idle,
            idle_note,
            freshness,
            result: counts,
          }, null, 2),
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          authoritative: 'result.ism',
          idle_note,
          cook: gen,
          idle,
          freshness,
          result: counts,
        }, null, 2),
      }],
    };
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `pcg_cook_and_wait error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

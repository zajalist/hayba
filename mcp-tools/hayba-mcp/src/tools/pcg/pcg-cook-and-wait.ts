import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import { runUePythonJson, pyStr } from '../ue-python.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['mutates_scene', 'gpu_load', 'wait'],
  when: 'after editing a PCG graph, to regenerate an actor AND read back instance counts in ONE call — PCGComponent.generate is async, so a plain generate reads 0 instances in the same call',
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
    const counts = await runUePythonJson(inspectScript(actor), 30_000);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ok: true, cook: gen, idle, result: counts }, null, 2),
      }],
    };
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `pcg_cook_and_wait error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

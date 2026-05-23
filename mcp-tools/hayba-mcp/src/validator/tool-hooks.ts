// Tool-hook evaluators — wire concrete logic onto the catalog entries declared
// in `rules.ts`. Calling `installToolHooks()` once at server startup attaches
// every evaluator below.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { attachEvaluator, type ValidatorContext, type ValidatorFinding } from './rules.js';

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Convert an unknown tool result into a single best-effort string for regex
 *  matching against UE error text. */
function resultText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v ?? '');
}

// ── pcg_zero_instances_after_execute ────────────────────────────────────────
//
// After pcg_execute_graph returns with componentsExecuted > 0, issue a
// follow-up python_run to count HISM/ISM instances. If the total is zero we
// emit the finding. Falls back to "skip silently" if anything goes wrong —
// we don't want to drown the user in noise.

const PCG_COUNTER_SCRIPT = `
import json, os, unreal
out = {"total": 0, "actors": 0}
sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
if sub:
    for actor in sub.get_all_level_actors():
        if not isinstance(actor, unreal.Actor):
            continue
        for comp in actor.get_components_by_class(unreal.HierarchicalInstancedStaticMeshComponent):
            try:
                out["total"] += int(comp.get_instance_count())
                out["actors"] += 1
            except Exception:
                pass
        for comp in actor.get_components_by_class(unreal.InstancedStaticMeshComponent):
            try:
                out["total"] += int(comp.get_instance_count())
                out["actors"] += 1
            except Exception:
                pass
out_path = os.path.join(unreal.SystemLibrary.get_project_directory(), ".scratch", "validator_pcg_instance_count.json")
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "w") as f:
    json.dump(out, f)
print(json.dumps(out))
`;

async function evaluatePcgZeroInstances(ctx: ValidatorContext): Promise<ValidatorFinding | null> {
  const result = asRecord(ctx.toolResult);
  const componentsExecuted = Number(result.componentsExecuted ?? 0);
  if (componentsExecuted <= 0) return null;
  if (!ctx.ue) return null;

  // Send the counter script. Use a generous timeout — walking the world can
  // be slow on big levels.
  let resp;
  try {
    resp = await ctx.ue.send('python_run', { script: PCG_COUNTER_SCRIPT, allow_unsafe: true }, 15_000);
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  const outPath = join(ctx.scratchDir, 'validator_pcg_instance_count.json');
  let total = -1;
  if (existsSync(outPath)) {
    try {
      const parsed = JSON.parse(readFileSync(outPath, 'utf-8')) as { total?: number };
      total = Number(parsed.total ?? 0);
    } catch {
      total = -1;
    } finally {
      try { unlinkSync(outPath); } catch { /* swallow */ }
    }
  } else {
    // Fall back to the print() value embedded in the response.
    const data = asRecord(resp.data);
    const printed = typeof data.stdout === 'string' ? data.stdout : '';
    const m = printed.match(/\{[^}]*"total"\s*:\s*(\d+)/);
    if (m) total = Number(m[1]);
  }

  if (total !== 0) return null;

  return {
    ruleId: 'pcg_zero_instances_after_execute',
    severity: 'warning',
    message: 'PCG graph executed but produced 0 instances in the world',
    hint: 'The graph ran (componentsExecuted > 0) but no HISM/ISM instances exist on any actor. Common causes: Surface Sampler bound to a non-landscape source, all points culled by a Density filter, or output pin not wired to a Static Mesh Spawner.',
    refs: ['[[pcg-surface-sampler-needs-landscape]]'],
    context: {
      graph: ctx.toolArgs.assetPath ?? ctx.toolArgs.graphPath ?? null,
      componentsExecuted,
      instances: 0,
    },
    timestamp: nowIso(),
    toolName: ctx.toolName,
  };
}

// ── pcg_execute_no_component_in_world ───────────────────────────────────────

async function evaluatePcgNoComponentInWorld(ctx: ValidatorContext): Promise<ValidatorFinding | null> {
  const text = resultText(ctx.toolResult);
  if (!/No PCGComponents? found using this graph/i.test(text)) return null;
  return {
    ruleId: 'pcg_execute_no_component_in_world',
    severity: 'warning',
    message: 'No PCGComponent in the level is bound to the executed graph',
    hint: 'pcg_execute_graph found 0 PCGComponents referencing this graph. Drop a PCGVolume into the level and assign the graph, or spawn one with actor_spawn before re-executing.',
    refs: ['[[pcg-execute-needs-component]]'],
    context: { graph: ctx.toolArgs.assetPath ?? ctx.toolArgs.graphPath ?? null },
    timestamp: nowIso(),
    toolName: ctx.toolName,
  };
}

// ── pcg_asset_not_found ─────────────────────────────────────────────────────

async function evaluatePcgAssetNotFound(ctx: ValidatorContext): Promise<ValidatorFinding | null> {
  const text = resultText(ctx.toolResult);
  if (!/(asset not found|could not load asset|invalid asset path|failed to load PCG ?Graph)/i.test(text)) return null;
  return {
    ruleId: 'pcg_asset_not_found',
    severity: 'error',
    message: 'PCG asset path could not be resolved',
    hint: 'Double-check the path (must start with /Game/) and list candidates with hayba_list_pcg_assets.',
    refs: ['[[pcg-asset-path-resolution]]'],
    context: { assetPath: ctx.toolArgs.assetPath ?? null },
    timestamp: nowIso(),
    toolName: ctx.toolName,
  };
}

// ── landscape_import_no_landscape_in_world ──────────────────────────────────

const LANDSCAPE_COUNTER_SCRIPT = `
import json, os, unreal
count = 0
sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
if sub:
    for a in sub.get_all_level_actors():
        if isinstance(a, unreal.LandscapeProxy):
            count += 1
out_path = os.path.join(unreal.SystemLibrary.get_project_directory(), ".scratch", "validator_landscape_count.json")
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "w") as f:
    json.dump({"count": count}, f)
print(json.dumps({"count": count}))
`;

async function evaluateLandscapeImportSilentFailure(ctx: ValidatorContext): Promise<ValidatorFinding | null> {
  const result = asRecord(ctx.toolResult);
  // Only fire when the tool claims success.
  if (result.ok === false) return null;
  if (!ctx.ue) return null;

  let resp;
  try {
    resp = await ctx.ue.send('python_run', { script: LANDSCAPE_COUNTER_SCRIPT, allow_unsafe: true }, 10_000);
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  const outPath = join(ctx.scratchDir, 'validator_landscape_count.json');
  let count = -1;
  if (existsSync(outPath)) {
    try {
      const parsed = JSON.parse(readFileSync(outPath, 'utf-8')) as { count?: number };
      count = Number(parsed.count ?? 0);
    } catch {
      count = -1;
    } finally {
      try { unlinkSync(outPath); } catch { /* swallow */ }
    }
  }

  if (count !== 0) return null;

  return {
    ruleId: 'landscape_import_no_landscape_in_world',
    severity: 'error',
    message: 'landscape_import returned success but no LandscapeProxy exists in the world',
    hint: 'Check the editor output log filtered by `LogHaybaMCPImporter` for the underlying error.',
    refs: ['[[landscape-import-silent-failure]]'],
    context: { args: ctx.toolArgs },
    timestamp: nowIso(),
    toolName: ctx.toolName,
  };
}

// ── asset_browse_describe_assets_missing ────────────────────────────────────

async function evaluateAssetBrowseDescribeMissing(ctx: ValidatorContext): Promise<ValidatorFinding | null> {
  const text = resultText(ctx.toolResult);
  if (!/Unknown command:\s*describe_assets/i.test(text)) return null;
  return {
    ruleId: 'asset_browse_describe_assets_missing',
    severity: 'warning',
    message: 'UE responded "Unknown command: describe_assets" — the plugin is out of date',
    hint: 'Rebuild HaybaMCPToolkit from source, or fall back to python_run with unreal.EditorAssetLibrary.list_assets().',
    refs: ['[[asset-browse-plugin-out-of-date]]'],
    timestamp: nowIso(),
    toolName: ctx.toolName,
  };
}

// ── tcp_socket_to_self_in_python_run (post-condition only — pre-flight is
//    enforced separately in python-run-validator-wrap.ts) ──────────────────

async function evaluatePythonRunSelfSocket(ctx: ValidatorContext): Promise<ValidatorFinding | null> {
  const script = String(asRecord(ctx.toolArgs).script ?? '');
  if (!isSelfSocketScript(script)) return null;
  return {
    ruleId: 'tcp_socket_to_self_in_python_run',
    severity: 'error',
    message: 'python_run script opens a TCP socket to the UE plugin port (would deadlock)',
    hint: 'Use the Python plugin API (`unreal.*`) directly instead of round-tripping through the TCP server (52342–52350).',
    refs: ['[[python-run-no-self-connect]]'],
    timestamp: nowIso(),
    toolName: ctx.toolName,
  };
}

/** Shared by both the post-condition above and the pre-flight wrapper.
 *  Matches any `<name>.connect(("127.0.0.1"|"localhost", PORT))` where
 *  PORT is in the UE plugin range 52342..52350. */
export function isSelfSocketScript(script: string): boolean {
  const re = /\.\s*connect\s*\(\s*\(\s*['"](?:127\.0\.0\.1|localhost)['"]\s*,\s*(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const port = Number(m[1]);
    if (port >= 52342 && port <= 52350) return true;
  }
  return false;
}

// ── actor_spawn_not_on_landscape ────────────────────────────────────────────
//
// Fires when an agent spawns a StaticMesh asset with an explicit Z but
// without `snap_to_landscape: true`. The 2026-05-23 Palestine scene session
// produced two batches of pillars at z=-50 floating below the landscape
// surface because the agent guessed Z instead of asking the plugin to
// snap. The plugin now ships a snap parameter on actor_spawn — this rule
// surfaces "you forgot to use it" before the user notices in a screenshot.
async function evaluateActorSpawnNotOnLandscape(ctx: ValidatorContext): Promise<ValidatorFinding | null> {
  const args = asRecord(ctx.toolArgs);
  const result = asRecord(ctx.toolResult);

  // Only fire for mesh-style class_paths (/Game/...). UClass spawns
  // (DirectionalLight, PostProcessVolume, blueprint actor classes) aren't
  // expected to sit on the landscape and would be noise.
  const classPath = String(args.class_path ?? '');
  if (!classPath.startsWith('/Game/')) return null;

  // If the agent already passed snap_to_landscape:true, the plugin handled
  // it — nothing to warn about.
  if (args.snap_to_landscape === true) return null;

  // If the response includes snapped_to_landscape:true, the snap happened
  // server-side — also nothing to warn about. (Defensive in case the
  // plugin starts snapping by default.)
  if (result.snapped_to_landscape === true) return null;

  // Only fire when the agent supplied an explicit location with a Z that
  // looks "guessed" (not aligned to a landscape value). We don't know the
  // landscape height here without round-tripping, but we DO know that the
  // agent didn't ask the plugin to figure it out — surface that.
  const loc = Array.isArray(args.location) ? args.location as unknown[] : null;
  if (!loc || loc.length !== 3) return null;

  const label = String(args.label ?? result.label ?? '<unlabeled>');
  return {
    ruleId: 'actor_spawn_not_on_landscape',
    severity: 'warning',
    message: `actor_spawn "${label}" placed a mesh with explicit Z and no snap_to_landscape — may float or bury`,
    hint: 'Pass snap_to_landscape:true (and z_offset for pivot-shifted assets like SM_GiantTree_01 which needs -380). The plugin will line-trace the landscape and set Z for you. No python_run round-trip needed.',
    refs: ['[[actor-spawn-snap-to-landscape]]'],
    timestamp: nowIso(),
    toolName: ctx.toolName,
    context: {
      label,
      actor_id: typeof result.actor_id === 'string' ? result.actor_id : undefined,
      class_path: classPath,
      location: loc,
    },
  };
}

// ── actor_tilted_but_not_buried ─────────────────────────────────────────────
//
// Fires when an agent snaps a tilted static-mesh prop flat onto the
// landscape with z_offset >= 0. The pillar in the user's first screenshot
// (BrokenPillar_06, pitch=78°) was the perfect example: snap_to_landscape
// placed its pivot at the surface, but a real fallen pillar would have
// cracked off its base and embedded into the dirt. The fix is a negative
// z_offset to bury the base under the surface — the top stays visible
// and tilted, but the prop reads as "fell here" instead of "floating".
//
// Triggers on both actor_spawn and actor_transform.
async function evaluateActorTiltedNotBuried(ctx: ValidatorContext): Promise<ValidatorFinding | null> {
  const args = asRecord(ctx.toolArgs);
  const result = asRecord(ctx.toolResult);

  // Only fire for mesh-style class_paths (actor_spawn) or once we know
  // the actor exists (actor_transform). UClass spawns like
  // DirectionalLight rotate by design — exclude those.
  if (ctx.toolName === 'actor_spawn') {
    const classPath = String(args.class_path ?? '');
    if (!classPath.startsWith('/Game/')) return null;
  }

  const rot = Array.isArray(args.rotation) ? args.rotation as unknown[] : null;
  if (!rot || rot.length !== 3) return null;
  const pitch = Number(rot[0]);
  const yaw = Number(rot[1]);
  const roll = Number(rot[2]);
  void yaw; // yaw is rotation about vertical — never causes float-on-surface issues.

  function distFromStable(angleDeg: number): number {
    if (!Number.isFinite(angleDeg)) return 0;
    const norm = ((angleDeg % 360) + 360) % 360;
    return Math.min(
      Math.abs(norm - 0),
      Math.abs(norm - 90),
      Math.abs(norm - 180),
      Math.abs(norm - 270),
      Math.abs(norm - 360),
    );
  }
  const pitchOff = distFromStable(pitch);
  const rollOff = distFromStable(roll);
  const tilted = pitchOff >= 10 || rollOff >= 10;
  if (!tilted) return null;

  // Snap-on-surface OR a positive z_offset both qualify as "not buried".
  // The plugin's snap_to_landscape with z_offset:0 (or unset) lands the
  // pivot on the surface — for a tilted prop that means floating.
  const snapped = result.snapped_to_landscape === true || args.snap_to_landscape === true;
  const zOffset = typeof args.z_offset === 'number' ? args.z_offset : 0;
  if (!snapped) return null;        // not snapped → user controls Z directly
  if (zOffset < -20) return null;   // already buried meaningfully

  const label = String(args.label ?? result.label ?? args.actor_id ?? result.actor_id ?? '<unlabeled>');
  return {
    ruleId: 'actor_tilted_but_not_buried',
    severity: 'warning',
    message: `Tilted "${label}" (pitch=${pitch.toFixed(0)}° roll=${roll.toFixed(0)}°) snapped to surface with z_offset=${zOffset} — looks mid-fall instead of fallen`,
    hint: 'For a tilted broken prop, pair snap_to_landscape:true with a negative z_offset (~-60 to -120 for stone) so the base embeds into the dirt. The top stays visible and tilted; the silhouette reads as "fell and embedded" rather than balanced on an edge.',
    refs: ['[[actor-tilted-needs-burial]]'],
    timestamp: nowIso(),
    toolName: ctx.toolName,
    context: {
      label,
      actor_id: typeof result.actor_id === 'string' ? result.actor_id : (typeof args.actor_id === 'string' ? args.actor_id : undefined),
      pitch, yaw, roll,
      pitch_off_cardinal: pitchOff,
      roll_off_cardinal: rollOff,
      z_offset: zOffset,
    },
  };
}

// ── actor_snap_to_landscape_silently_failed ─────────────────────────────────
//
// Fires when the agent passed snap_to_landscape:true but the plugin
// response does NOT include snapped_to_landscape:true. Means the line
// trace missed the LandscapeProxy (typically because other actors are
// stacked above the spawn XY and intercepted a LineTraceSingle hit).
// The 2026-05-23 Palestine scene shipped a CorbelSadness + several
// rocks at z=0 (below the visible ground) for exactly this reason —
// the agent thought the snap had worked because no error came back.
async function evaluateActorSnapSilentFailure(ctx: ValidatorContext): Promise<ValidatorFinding | null> {
  const args = asRecord(ctx.toolArgs);
  const result = asRecord(ctx.toolResult);
  if (args.snap_to_landscape !== true) return null;
  // If the plugin DID snap, response carries snapped_to_landscape:true
  // (and snapped_z). Absence of that key after asking for snap = silent
  // failure.
  if (result.snapped_to_landscape === true) return null;
  // If the response is an error / plan-mode rejection, skip — the spawn
  // didn't happen and a separate failure path will surface it.
  if (result.status === 'plan_mode_required' || result.error) return null;

  const label = String(args.label ?? result.label ?? args.actor_id ?? result.actor_id ?? '<unlabeled>');
  return {
    ruleId: 'actor_snap_to_landscape_silently_failed',
    severity: 'warning',
    message: `"${label}" requested snap_to_landscape but the response shows it did not snap — actor is likely floating or buried`,
    hint: 'The line trace probably hit another actor stacked above this XY before reaching the landscape. Rebuild the plugin to pick up PR #232 commit 12 (LineTraceMulti + IgnoredActor) which fixes this, OR transform the actor explicitly to a Z that matches nearby snapped neighbours.',
    refs: ['[[actor-snap-silent-failure]]'],
    timestamp: nowIso(),
    toolName: ctx.toolName,
    context: {
      label,
      actor_id: typeof result.actor_id === 'string' ? result.actor_id : (typeof args.actor_id === 'string' ? args.actor_id : undefined),
      requested_snap: true,
    },
  };
}

// ── installer ───────────────────────────────────────────────────────────────

let INSTALLED = false;

export function installToolHooks(): void {
  if (INSTALLED) return;
  INSTALLED = true;
  attachEvaluator('pcg_zero_instances_after_execute',  evaluatePcgZeroInstances);
  attachEvaluator('pcg_execute_no_component_in_world', evaluatePcgNoComponentInWorld);
  attachEvaluator('pcg_asset_not_found',                evaluatePcgAssetNotFound);
  attachEvaluator('landscape_import_no_landscape_in_world', evaluateLandscapeImportSilentFailure);
  attachEvaluator('asset_browse_describe_assets_missing',   evaluateAssetBrowseDescribeMissing);
  attachEvaluator('tcp_socket_to_self_in_python_run',       evaluatePythonRunSelfSocket);
  attachEvaluator('actor_spawn_not_on_landscape',           evaluateActorSpawnNotOnLandscape);
  attachEvaluator('actor_tilted_but_not_buried',            evaluateActorTiltedNotBuried);
  attachEvaluator('actor_snap_to_landscape_silently_failed', evaluateActorSnapSilentFailure);
}

/** Re-export so the test suite can reset between runs. */
export function _resetToolHooksForTests(): void {
  INSTALLED = false;
}

// Tool-hook evaluators — wire concrete logic onto the catalog entries declared
// in `rules.ts`. Calling `installToolHooks()` once at server startup attaches
// every evaluator below.

import { attachEvaluator, type ValidatorContext, type RuleFinding } from './rules.js';
import { probeCount } from './ue-probe.js';

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
import json, unreal
out = {"total": 0, "actors": 0}
sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
if sub:
    for actor in sub.get_all_level_actors():
        if not isinstance(actor, unreal.Actor):
            continue
        for comp in actor.get_components_by_class(unreal.HierarchicalInstancedStaticMeshComponent):
            out["total"] += int(comp.get_instance_count())
            out["actors"] += 1
        for comp in actor.get_components_by_class(unreal.InstancedStaticMeshComponent):
            out["total"] += int(comp.get_instance_count())
            out["actors"] += 1
print(json.dumps(out))
`;

async function evaluatePcgZeroInstances(ctx: ValidatorContext): Promise<RuleFinding | null> {
  const result = asRecord(ctx.toolResult);
  const componentsExecuted = Number(result.componentsExecuted ?? 0);
  if (componentsExecuted <= 0) return null;

  // Use a generous timeout — walking the world can be slow on big levels.
  const total = await probeCount(ctx.probe, {
    script: PCG_COUNTER_SCRIPT,
    key: 'total',
    timeoutMs: 15_000,
  });
  if (total !== 0) return null;

  return {
    ruleId: 'pcg_zero_instances_after_execute',
    severity: 'warning',
    message: 'PCG graph executed but produced 0 instances in the world',
    hint: 'The graph ran (componentsExecuted > 0) but no HISM/ISM instances exist on any actor. Common causes: Surface Sampler bound to a non-landscape source, all points culled by a Density filter, or output pin not wired to a Static Mesh Spawner.',
    refs: ['[[pcg-surface-sampler-needs-landscape]]'],
    data: {
      graph: ctx.toolArgs.assetPath ?? ctx.toolArgs.graphPath ?? null,
      componentsExecuted,
      instances: 0,
    },
    timestamp: nowIso(),
    toolName: ctx.toolName,
  };
}

// ── pcg_execute_no_component_in_world ───────────────────────────────────────

async function evaluatePcgNoComponentInWorld(ctx: ValidatorContext): Promise<RuleFinding | null> {
  const text = resultText(ctx.toolResult);
  if (!/No PCGComponents? found using this graph/i.test(text)) return null;
  return {
    ruleId: 'pcg_execute_no_component_in_world',
    severity: 'warning',
    message: 'No PCGComponent in the level is bound to the executed graph',
    hint: 'pcg_execute_graph found 0 PCGComponents referencing this graph. Drop a PCGVolume into the level and assign the graph, or spawn one with actor_spawn before re-executing.',
    refs: ['[[pcg-execute-needs-component]]'],
    data: { graph: ctx.toolArgs.assetPath ?? ctx.toolArgs.graphPath ?? null },
    timestamp: nowIso(),
    toolName: ctx.toolName,
  };
}

// ── pcg_asset_not_found ─────────────────────────────────────────────────────

async function evaluatePcgAssetNotFound(ctx: ValidatorContext): Promise<RuleFinding | null> {
  const text = resultText(ctx.toolResult);
  if (!/(asset not found|could not load asset|invalid asset path|failed to load PCG ?Graph)/i.test(text)) return null;
  return {
    ruleId: 'pcg_asset_not_found',
    severity: 'error',
    message: 'PCG asset path could not be resolved',
    hint: 'Double-check the path (must start with /Game/) and list candidates with hayba_list_pcg_assets.',
    refs: ['[[pcg-asset-path-resolution]]'],
    data: { assetPath: ctx.toolArgs.assetPath ?? null },
    timestamp: nowIso(),
    toolName: ctx.toolName,
  };
}

// ── landscape_import_no_landscape_in_world ──────────────────────────────────

const LANDSCAPE_COUNTER_SCRIPT = `
import json, unreal
count = 0
sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
if sub:
    for a in sub.get_all_level_actors():
        if isinstance(a, unreal.LandscapeProxy):
            count += 1
print(json.dumps({"count": count}))
`;

async function evaluateLandscapeImportSilentFailure(ctx: ValidatorContext): Promise<RuleFinding | null> {
  const result = asRecord(ctx.toolResult);
  // Only fire when the tool claims success.
  if (result.ok === false) return null;

  const count = await probeCount(ctx.probe, {
    script: LANDSCAPE_COUNTER_SCRIPT,
    key: 'count',
    timeoutMs: 10_000,
  });
  if (count !== 0) return null;

  return {
    ruleId: 'landscape_import_no_landscape_in_world',
    severity: 'error',
    message: 'landscape_import returned success but no LandscapeProxy exists in the world',
    hint: 'Check the editor output log filtered by `LogHaybaMCPImporter` for the underlying error.',
    refs: ['[[landscape-import-silent-failure]]'],
    data: { args: ctx.toolArgs },
    timestamp: nowIso(),
    toolName: ctx.toolName,
  };
}

// ── asset_browse_describe_assets_missing ────────────────────────────────────

async function evaluateAssetBrowseDescribeMissing(ctx: ValidatorContext): Promise<RuleFinding | null> {
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

async function evaluatePythonRunSelfSocket(ctx: ValidatorContext): Promise<RuleFinding | null> {
  const script = String(asRecord(ctx.toolArgs).script ?? '');
  if (!isSelfSocketScript(script)) return null;
  return {
    ruleId: 'tcp_socket_to_self_in_python_run',
    severity: 'error',
    message:
      'python_run policy_blocked [HCR-BLOCK-001]: script opens a TCP socket to the UE plugin port (would deadlock)',
    hint: 'Use the Python plugin API (`unreal.*`) directly instead of round-tripping through the TCP server (52342–52350). Retry unchanged: forbidden; this guard is non-bypassable.',
    refs: ['[[python-run-no-self-connect]]'],
    // `data`, not `context`: this branch collapsed the five finding shapes into
    // one, and the Validation panel reads `data`. Their content is kept as-is.
    data: {
      policy_code: 'HCR-BLOCK-001',
      matched_rule: 'loopback MCP socket connection',
      retry_unchanged: 'forbidden',
    },
    timestamp: nowIso(),
    toolName: ctx.toolName,
  };
}

/** Pre-flight detector for the #283/#284 dangling-delegate crash class.
 *  Matches engine-lifetime callback registrations that, from a one-shot
 *  python_run, bind a Python callable the interpreter then garbage-collects —
 *  so the next engine broadcast dereferences freed memory and crashes the
 *  editor with a native access violation (python311 → PythonScriptPlugin →
 *  CoreUObject). These have NO safe use from python_run, so we reject the call
 *  before it ever reaches UE. Mirrors the authoritative C++ gate in
 *  HaybaMCPPythonHandler::Run (DetectDanglingLifetimeRegistrations).
 *  Returns the matched pattern, or null if none. */
export function danglingLifetimeRegistration(script: string): string | null {
  const patterns = [
    'register_slate_post_tick_callback',
    'register_slate_pre_tick_callback',
    'register_python_shutdown_callback',
    'register_post_engine_init_callback',
  ];
  for (const p of patterns) {
    if (script.includes(p)) return p;
  }
  return null;
}

/** Shared by both the post-condition above and the pre-flight wrapper.
 *  Matches any `<name>.connect(("127.0.0.1"|"localhost", PORT))` where
 *  PORT is in the UE plugin range 52342..52350. */
export function isSelfSocketScript(script: string): boolean {
  // Two idioms, both deadlocking, both common:
  //
  //   s.connect(("127.0.0.1", 52342))                 <- socket method
  //   socket.create_connection(("127.0.0.1", 52342))  <- the one-liner
  //
  // Only the first was matched here. The second is arguably the MORE likely
  // thing an agent writes, and it reached the game thread unrefused while
  // docs/RELIABILITY.md said the pattern was refused outright.
  //
  // The host list is the union of two independent fixes: `0.0.0.0` (a bind-all
  // address that still resolves to this machine) and `::1` (IPv6 loopback,
  // which Python reaches whenever the host resolves that way). Either alone
  // leaves a live hole, and neither branch had both.
  const re = /(?:\.\s*connect|\bcreate_connection)\s*\(\s*\(\s*['"](?:127\.0\.0\.1|localhost|0\.0\.0\.0|::1)['"]\s*,\s*(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const port = Number(m[1]);
    if (port >= 52342 && port <= 52350) return true;
  }
  return false;
}

// ── installer ───────────────────────────────────────────────────────────────

let INSTALLED = false;

export function installToolHooks(): void {
  if (INSTALLED) return;
  INSTALLED = true;
  attachEvaluator('pcg_zero_instances_after_execute', evaluatePcgZeroInstances);
  attachEvaluator('pcg_execute_no_component_in_world', evaluatePcgNoComponentInWorld);
  attachEvaluator('pcg_asset_not_found', evaluatePcgAssetNotFound);
  attachEvaluator('landscape_import_no_landscape_in_world', evaluateLandscapeImportSilentFailure);
  attachEvaluator('asset_browse_describe_assets_missing', evaluateAssetBrowseDescribeMissing);
  attachEvaluator('tcp_socket_to_self_in_python_run', evaluatePythonRunSelfSocket);
}

/** Re-export so the test suite can reset between runs. */
export function _resetToolHooksForTests(): void {
  INSTALLED = false;
}

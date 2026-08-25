// Validator rule registry.
//
// Each rule has a canonical id (matches Section F of
// `docs/superpowers/specs/2026-05-22-environmental-design-guardrails.md` and
// the AI-floppy patterns identified in the 2026-05-23 PCG/landscape MCP
// postmortem). Rules can be evaluated automatically (post-condition of a tool
// call) or be catalog-only — listed in the UI so the user knows the system
// would warn them, even before an evaluator is wired.
//
// The catalog is the source of truth for the UI; runtime evaluators live in
// `tool-hooks.ts` and are attached to entries below by reference, not by
// duplicating the metadata.

import type { UeProbe } from './ue-probe.js';
import type { Finding } from './finding.js';
import type { RuleCategory } from './config.js';

export type ValidatorSeverity = 'error' | 'warning' | 'info';

export interface ValidatorContext {
  /** Name of the tool whose post-condition is being evaluated. */
  toolName: string;
  /** The validated args the tool was called with. */
  toolArgs: Record<string, unknown>;
  /** The raw response value the tool returned (TS-side, before MCP wrapping). */
  toolResult: unknown;
  /** Runs a python follow-up query inside the editor. Null when no editor is
   *  reachable (and in unit tests) — rules that need it must skip, not guess. */
  probe: UeProbe | null;
  /** Where to scratch intermediate JSON files (default = repo `.scratch/`). */
  scratchDir: string;
}

/** What an evaluator returns. `category` and the record fields are stamped by
 *  the runner from the rule and the call that triggered it, so an evaluator
 *  that omits them is not being sloppy -- it is not repeating itself. */
export type RuleFinding = Omit<Finding, 'category'> & { category?: RuleCategory };

export type ValidatorTrigger =
  | 'manual'
  | { after_tool: string | string[] };

export interface ValidatorRule {
  id: string;
  /** Which subsystem the rule speaks about. Stamped onto its findings. */
  category: RuleCategory;
  severity: ValidatorSeverity;
  message: string;
  hint: string;
  refs?: string[];
  trigger: ValidatorTrigger;
  /** When omitted, the rule is descriptive only — present in the catalog so
   *  users see it in the Configure panel, but never auto-evaluated. */
  evaluate?: (ctx: ValidatorContext) => Promise<RuleFinding | null>;
}

// ── Catalog ─────────────────────────────────────────────────────────────────
//
// Evaluators are assigned in `tool-hooks.ts` via `attachEvaluator()`. Keeping
// the catalog data-only here means tests can import this module without
// pulling in the TCP / python_run plumbing.

export const RULES: ValidatorRule[] = [
  // ── Section F: 5 rules from PR #227 ─────────────────────────────────────
  {
    id: 'pcg_zero_instances_after_execute',
    category: 'pcg',
    severity: 'warning',
    message: 'PCG graph executed but produced 0 instances in the world',
    hint: 'The graph ran (componentsExecuted > 0) but no Hierarchical/Instanced Static Mesh instances exist on any PCGVolume using it. Common causes: Surface Sampler bound to a non-landscape source, all points culled by a Density filter, or output pin not wired to a Static Mesh Spawner. Inspect the graph in the editor and re-run with hayba_execute_pcg_graph.',
    refs: ['[[pcg-surface-sampler-needs-landscape]]', '[[pcg-zero-instances-postmortem]]'],
    trigger: { after_tool: ['pcg_execute_graph', 'hayba_execute_pcg_graph'] },
  },
  {
    id: 'tcp_socket_to_self_in_python_run',
    category: 'python',
    severity: 'error',
    message: 'python_run script opens a TCP socket to the UE plugin port (would deadlock)',
    hint: 'Calling back into the MCP TCP listener (52342–52350) from inside a python_run script reenters the game thread and crashes UE. Use the Python plugin API (`unreal.*`) directly instead of round-tripping through the TCP server.',
    refs: ['[[python-run-no-self-connect]]'],
    trigger: { after_tool: 'python_run' },
  },
  {
    id: 'dangling_lifetime_callback_in_python_run',
    category: 'python',
    severity: 'error',
    message: 'python_run script registers an engine-lifetime callback that would dangle and crash the editor',
    hint: 'register_slate_post/pre_tick_callback, register_python_shutdown_callback and register_post_engine_init_callback bind a Python callable into an engine-lifetime delegate. From a one-shot python_run the callable is garbage-collected as soon as the call returns, so the next engine broadcast dereferences freed memory and crashes the editor with a native access violation (#283/#284). Do the work inline, or keep the callable on a module-global and pass allow_unsafe=true.',
    refs: ['[[python-run-no-dangling-delegate]]'],
    trigger: 'manual',
  },

  // ── Other 5 AI-floppy hints from the postmortem ─────────────────────────
  {
    id: 'pcg_execute_no_component_in_world',
    category: 'pcg',
    severity: 'warning',
    message: 'No PCGComponent in the level is bound to the executed graph',
    hint: 'pcg_execute_graph found 0 PCGComponents referencing this graph. Either drop a PCGVolume into the level and assign the graph, or use actor_spawn to spawn one programmatically before re-executing.',
    refs: ['[[pcg-execute-needs-component]]'],
    trigger: { after_tool: ['pcg_execute_graph', 'hayba_execute_pcg_graph'] },
  },
  {
    id: 'pcg_asset_not_found',
    category: 'pcg',
    severity: 'error',
    message: 'PCG asset path could not be resolved',
    hint: 'The provided assetPath did not resolve to a PCGGraph. Double-check the path (must start with /Game/) and that the asset exists — list candidates with hayba_list_pcg_assets.',
    refs: ['[[pcg-asset-path-resolution]]'],
    trigger: { after_tool: ['pcg_execute_graph', 'hayba_execute_pcg_graph', 'hayba_export_pcg_graph'] },
  },
  {
    id: 'landscape_import_no_landscape_in_world',
    category: 'landscape',
    severity: 'error',
    message: 'landscape_import returned success but no LandscapeProxy exists in the world',
    hint: 'The import handler reported ok=true but no `unreal.LandscapeProxy` actor is present in the editor world. Check the editor output log filtered by `LogHaybaMCPImporter` for the underlying error.',
    refs: ['[[landscape-import-silent-failure]]'],
    trigger: { after_tool: 'landscape_import' },
  },
  {
    id: 'asset_browse_describe_assets_missing',
    category: 'asset',
    severity: 'warning',
    message: 'UE responded "Unknown command: describe_assets" — the plugin is out of date',
    hint: 'The hayba_asset_browse handler relies on the `describe_assets` UE command which is missing in this plugin build. Rebuild the HaybaMCPToolkit plugin from source, or use `python_run` with `unreal.EditorAssetLibrary.list_assets()` as a fallback.',
    refs: ['[[asset-browse-plugin-out-of-date]]'],
    trigger: { after_tool: ['hayba_asset_browse', 'hayba_asset_search'] },
  },
];

/** Build an id → rule lookup (rebuilt on each call so tests can mutate). */
export function rulesById(): Map<string, ValidatorRule> {
  const m = new Map<string, ValidatorRule>();
  for (const r of RULES) m.set(r.id, r);
  return m;
}

/** All rules whose trigger matches the given tool name. */
export function rulesForTool(toolName: string): ValidatorRule[] {
  const matches: ValidatorRule[] = [];
  for (const r of RULES) {
    if (r.trigger === 'manual') continue;
    const t = r.trigger.after_tool;
    if (Array.isArray(t) ? t.includes(toolName) : t === toolName) matches.push(r);
  }
  return matches;
}

/** Attach (or override) the evaluator for a rule by id. Used by tool-hooks
 *  to keep the catalog data-only while still wiring real logic. */
export function attachEvaluator(
  id: string,
  fn: NonNullable<ValidatorRule['evaluate']>,
): void {
  const r = rulesById().get(id);
  // rulesById() returned a copy of the map; we mutate the original RULES entry.
  const target = RULES.find(x => x.id === id);
  if (!target) throw new Error(`attachEvaluator: rule "${id}" not found`);
  target.evaluate = fn;
  void r;
}

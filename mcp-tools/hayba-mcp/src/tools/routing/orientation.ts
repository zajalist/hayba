// First-contact orientation.
//
// A fresh install registers seven tools (see CORE_META). That is the right
// default for context cost, but on its own it is a worse experience than a
// bloated one: an agent sees seven names, no map, and no reason to believe the
// other seventy exist. The saving only pays off if the agent knows how to reach
// the rest — so the first response it gets says so, once, and then never again.
//
// Everything here is derived from live registry state rather than written down,
// because an orientation that drifts out of date is worse than none: it teaches
// the agent things that are no longer true.

import type { PackRegistry } from './pack-registry.js';

export interface OrientationInput {
  /** Every tool the server knows about, loaded or not. */
  totalTools: number;
  /** Tools registered right now. */
  loadedTools: string[];
  registry: PackRegistry;
}

/** Domains worth naming up front. Anything else is still discoverable by
 *  search — this is a signpost, not a catalogue. */
const HEADLINE_PACK_LIMIT = 12;

/** Comma-join across lines at a readable width. A single 200-character line of
 *  domain names is technically the same information and much harder to scan. */
function wrap(items: string[], width = 72, indent = '  '): string {
  const lines: string[] = [];
  let line = '';
  for (const item of items) {
    const next = line ? `${line}, ${item}` : item;
    if (next.length > width && line) {
      lines.push(line + ',');
      line = item;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

export function buildOrientation(input: OrientationInput): string {
  const { totalTools, loadedTools, registry } = input;

  const packs = registry.listPacks();
  const domainPacks = packs.filter((p) => p.kind === 'domain');
  const workflowPacks = packs.filter((p) => p.kind !== 'domain');

  const named = wrap(
    domainPacks
      .slice()
      .sort((a, b) => b.tools.length - a.tools.length)
      .slice(0, HEADLINE_PACK_LIMIT)
      .map((p) => `${p.name} (${p.tools.length})`),
  );

  const moreDomains = Math.max(0, domainPacks.length - HEADLINE_PACK_LIMIT);
  const moreNote = moreDomains > 0 ? `, and ${moreDomains} more` : '';


  const workflowNote =
    workflowPacks.length > 0
      ? `\n  Workflow packs bundle tools across domains for a task: ${workflowPacks
          .map((p) => p.name)
          .join(', ')}.`
      : '';

  return `
HAYBA — first-contact orientation (shown once)
==============================================
This server drives a live Unreal Engine editor. ${totalTools} tools exist;
${loadedTools.length} are registered right now, deliberately.

The other ${totalTools - loadedTools.length} are not missing and need no "enabling".
They are one call away at all times:

  hayba_search_tools   describe what you want in plain language; get tool names back
  hayba_invoke         call ANY tool by name, loaded or not — no pack load required
  hayba_pack_load      register a domain natively when you will use it repeatedly
                       (an optimisation for schemas and autocomplete, never a
                       prerequisite for calling anything)

So the normal loop is: search → invoke. Reach for pack_load only when you are
about to make many calls into the same domain.

DOMAINS
  ${named}${moreNote}${workflowNote}
  hayba_pack_list gives the full list with tool counts and loaded state.
  list_tool_categories gives the honest per-domain command catalogue, including
  which commands the plugin supports but no agent wrapper exposes yet.

BEFORE ANY EDITOR WORK
  hayba_check_ue_status must report connected:true. Every UE-touching tool fails
  in a confusing way when it is not, and the failure rarely names the real cause.
  Connecting also auto-loads the editor pack.

WHAT TO EXPECT FROM RESULTS
  Tools report per-key outcomes rather than a bare ok:true — applied keys,
  rejected keys, and warnings come back named. If something was ignored, the
  response says which thing and why. Treat a silent success as a bug worth
  reporting, not as confirmation.
`.trim();
}

/** Session latch. The stdio transport runs one server process per client
 *  session, so module scope is session scope. Exported for tests. */
let oriented = false;

export function shouldOrient(): boolean {
  if (oriented) return false;
  oriented = true;
  return true;
}

export function __resetOrientation(): void {
  oriented = false;
}

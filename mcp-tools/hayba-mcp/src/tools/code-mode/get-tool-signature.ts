import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { deriveSignature, listRecordedCommands } from '../schema-registry.js';
import { isToolDisabled } from '../disabled-tools-watcher.js';
import {
  getLegacyCommand,
  listLegacyCommandNames,
  type LegacyCommandEntry,
  type LegacyParam,
} from '../../legacy-commands/index.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'reading the JSON schema of a specific HaybaOS command before invoking it',
  not_when: 'you only need a list of command names — use list_tool_categories instead',
};

function suggestClose(name: string, all: string[]): string[] {
  // Lightweight Levenshtein-like score so an LLM that guessed a wrong name
  // still gets a "did you mean" hint instead of a dead end.
  const lname = name.toLowerCase();
  const scored = all.map(n => {
    const ln = n.toLowerCase();
    let score = 0;
    if (ln === lname) score = 100;
    else if (ln.startsWith(lname) || lname.startsWith(ln)) score = 80;
    else if (ln.includes(lname) || lname.includes(ln)) score = 60;
    else {
      let i = 0;
      while (i < ln.length && i < lname.length && ln[i] === lname[i]) i++;
      score = i * 4;
    }
    return { n, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).filter(x => x.score > 0).map(x => x.n);
}

export const getToolSignatureHandler: ToolHandler = async (args) => {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) {
    return { content: [{ type: 'text', text: 'Error: command parameter is required' }], isError: true };
  }
  if (isToolDisabled(command)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'tool_disabled',
          command,
          hint: 'This tool is disabled in the Hayba MCP panel — ask the user to re-enable it there.',
        }, null, 2),
      }],
    };
  }
  const sig = deriveSignature(command);
  if (sig) {
    return { content: [{ type: 'text', text: JSON.stringify({ command, ...sig }, null, 2) }] };
  }

  // Fall back to the legacy-command sidecar before giving up. The sidecar
  // documents every UE-side command in HaybaMCPLegacyHandler.cpp that
  // doesn't have a TS Zod registration yet — without this path, calls
  // like get_tool_signature('landscape_import') would return
  // no_schema_available and steer the agent toward python_run, which was
  // the trigger for the crash documented in the 2026-05-23 postmortem.
  const legacy = getLegacyCommand(command);
  if (legacy) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          { command, ...legacyToSignature(legacy) },
          null,
          2,
        ),
      }],
    };
  }

  const did_you_mean = suggestClose(
    command,
    [...listRecordedCommands(), ...listLegacyCommandNames()],
  );
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'no_schema_available',
        command,
        hint: 'use list_tool_categories to discover commands, or hayba_invoke({ via: "ue_legacy" }) for UE-side handlers',
        did_you_mean,
      }, null, 2),
    }],
  };
};

/**
 * Convert a sidecar entry into the shape get_tool_signature emits for
 * registered TS tools (params:{name->descriptor}, returns:string, cost,
 * source). The descriptor format mirrors describeZod in
 * schema-registry.ts: "<type> (required|optional)[ — <description>]".
 *
 * source:'ue_legacy_stub' is the field the get_tool_signature.test.ts
 * suite asserts on — it lets a caller distinguish sidecar-sourced docs
 * from real Zod-derived ones, which matters because sidecar params are
 * hand-authored and can drift from the .cpp (the CI lint catches the
 * existence drift, but field-level drift would still slip through).
 */
function legacyToSignature(entry: LegacyCommandEntry): {
  params: Record<string, string>;
  returns: string;
  cost: 'low' | 'medium' | 'high';
  source: 'ue_legacy_stub';
  notes?: string;
} {
  const params: Record<string, string> = {};
  for (const p of entry.params) {
    params[p.name] = describeLegacyParam(p);
  }
  return {
    params,
    returns: stringifyReturns(entry),
    // Sidecar entries don't carry a cost — pick 'medium' as a safe
    // default for UE-side commands that may touch world state. Caller
    // can still gate via the agent_callable flag (surfaced separately
    // through hayba_invoke).
    cost: 'medium',
    source: 'ue_legacy_stub',
    ...(entry.notes ? { notes: entry.notes } : {}),
  };
}

function describeLegacyParam(p: LegacyParam): string {
  const qualifier = p.required ? '(required)' : '(optional)';
  const defaultPart =
    !p.required && p.default !== undefined
      ? `, default ${JSON.stringify(p.default)}`
      : '';
  const desc = p.description ? ` — ${p.description}` : '';
  return `${p.type} ${qualifier}${defaultPart}${desc}`;
}

function stringifyReturns(entry: LegacyCommandEntry): string {
  const r = entry.returns;
  if (r.shape !== 'object' || !r.fields || r.fields.length === 0) {
    return r.shape;
  }
  // Compact `{name: type, ...}` summary so the LLM caller sees the shape
  // at a glance without needing the full JSON tree.
  const parts = r.fields.map((f) => `${f.name}: ${f.type}`);
  return `{${parts.join(', ')}}`;
}

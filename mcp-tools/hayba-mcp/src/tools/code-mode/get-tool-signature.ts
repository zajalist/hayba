import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { deriveSignature, listRecordedCommands } from '../schema-registry.js';
import { isToolDisabled } from '../disabled-tools-watcher.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'reading the JSON schema of a specific HaybaOS command before invoking it',
  not_when: 'you only need a list of command names — use list_tool_categories instead',
};

/**
 * Manual stubs for UE legacy command param shapes.
 *
 * These are commands handled by `FHaybaMCPLegacyHandler` (C++ side) that have
 * no Zod-registered TS wrapper, so `deriveSignature` returns null for them.
 * Mirrors the `Params->TryGet*Field` calls in
 * `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPLegacyHandler.cpp`.
 *
 * This is the stop-gap before the schema-sidecar approach (postmortem 5.2)
 * lands. Keep entries narrow: just the fields the C++ handler actually reads.
 *
 * To invoke any of these via MCP, call
 * `hayba_invoke({ name: '<cmd>', via: 'ue_legacy', args: {...} })`.
 */
type LegacySig = {
  params: Record<string, string>;
  returns: string;
  cost: 'low' | 'medium' | 'high';
  hint?: string;
};
const LEGACY_SIGNATURES: Record<string, LegacySig> = {
  landscape_import: {
    params: {
      heightmapPath: 'string (required) — Absolute path to a PNG or R16 heightmap file',
      worldSizeKm: 'number (optional, default 8.0) — Landscape XY size in km',
      maxHeightM: 'number (optional, default 600.0) — Maximum height in m (0..maxHeightM mapped from uint16)',
      actorLabel: 'string (optional, default "Hayba_Terrain") — Label for the spawned Landscape actor',
      landscapeMaterial: 'string (optional) — UE material path; empty = no material',
    },
    returns: '{actorLabel, heightmapPath, worldSizeKm, maxHeightM}',
    cost: 'high',
    hint: 'TS wrapper exists as hayba_import_landscape; prefer that. Otherwise call via hayba_invoke({ via: "ue_legacy" }).',
  },
  describe_assets: {
    params: {
      paths: 'string[] (optional) — list of /Game asset paths to describe',
      classPaths: 'string[] (optional) — list of /Script class paths to describe',
    },
    returns: '{assets:[{path,class,size,tags}]}',
    cost: 'medium',
    hint: 'Used by hayba_asset_browse / hayba_asset_search. May not be implemented in all plugin builds — fall back to AssetRegistryHelpers via python_run.',
  },
  pcg_create_graph: {
    params: {
      assetPath: 'string (required) — /Game path where the new PCGGraph asset is saved',
      nodes: 'object[] (optional) — node specs ({type, id, params})',
      edges: 'object[] (optional) — edge specs ({from:{nodeId,pin}, to:{nodeId,pin}})',
    },
    returns: '{assetPath, ok}',
    cost: 'medium',
    hint: 'Prefer hayba_create_pcg_graph (TS wrapper).',
  },
  pcg_execute_graph: {
    params: {
      assetPath: 'string (required) — /Game path of the PCGGraph asset to execute',
      sourceActorLabel: 'string (optional) — label of the actor that hosts the PCGComponent',
    },
    returns: '{componentsExecuted, hism_counts}',
    cost: 'high',
    hint: 'Prefer hayba_execute_pcg_graph (TS wrapper). Verify hism_counts > 0; componentsExecuted alone does not prove instances spawned.',
  },
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
  if (!sig) {
    // Stop-gap: manual stubs for UE legacy handlers that aren't Zod-registered.
    const legacy = LEGACY_SIGNATURES[command];
    if (legacy) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            command,
            params: legacy.params,
            returns: legacy.returns,
            cost: legacy.cost,
            source: 'ue_legacy_stub',
            ...(legacy.hint ? { hint: legacy.hint } : {}),
          }, null, 2),
        }],
      };
    }
    const allKnown = [...listRecordedCommands(), ...Object.keys(LEGACY_SIGNATURES)];
    const did_you_mean = suggestClose(command, allKnown);
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
  }
  return { content: [{ type: 'text', text: JSON.stringify({ command, ...sig }, null, 2) }] };
};

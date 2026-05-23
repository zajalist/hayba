// Static loader for the legacy command sidecar. Imported by:
//   - tools/code-mode/get-tool-signature.ts (for parameter docs)
//   - tools/routing/meta-tools/invoke.ts    (for the ue_legacy allowlist)
//   - scripts/check-legacy-wrappers.ts      (CI lint)
//
// The sidecar JSON is the single source of truth for every UE-side
// command in HaybaMCPLegacyHandler::ProcessCommand. See sidecar.json's
// top-of-file _doc field for the contract.

// Static disk read of the sidecar at module load. We use readFileSync rather
// than `import sidecarJson from './sidecar.json'` because the TS5.9 +
// module:Node16 combo in this repo doesn't accept the new
// `with { type: 'json' }` import-attribute syntax, and the older
// `assert { type: 'json' }` form is deprecated in Node 22+. The file is
// resolved relative to the compiled module, so it works in both src/ (under
// vitest) and dist/ (under the shipped binary) provided sidecar.json is
// emitted alongside the JS — see build:assets in package.json.
// This stays compatible with the no-dynamic-require / no-unsafe-eval rule:
// the path is a compile-time constant and the JSON has no executable bits.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sidecarPath = join(__dirname, 'sidecar.json');
const sidecarJson = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as unknown;

export type LegacyParamType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'any';

export interface LegacyParam {
  name: string;
  type: LegacyParamType;
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface LegacyReturnField {
  name: string;
  type: string;
  description?: string;
}

export interface LegacyReturns {
  shape: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'any';
  fields?: LegacyReturnField[];
}

export interface LegacyCommandEntry {
  aliases?: string[];
  handler_cpp: string;
  params: LegacyParam[];
  returns: LegacyReturns;
  agent_callable: boolean;
  has_ts_wrapper: boolean;
  notes?: string;
}

export interface LegacySidecar {
  version: number;
  commands: Record<string, LegacyCommandEntry>;
}

// Cast through unknown — the import is structurally typed as the JSON
// literal it actually is, which TS infers as a deep readonly tree. We
// want a mutable-feeling shape for downstream consumers but never mutate
// it; treat the returned object as read-only by convention.
const sidecar: LegacySidecar = sidecarJson as unknown as LegacySidecar;

export function getSidecar(): LegacySidecar {
  return sidecar;
}

export function getLegacyCommand(name: string): LegacyCommandEntry | null {
  return sidecar.commands[name] ?? null;
}

export function listLegacyCommandNames(): string[] {
  return Object.keys(sidecar.commands);
}

/**
 * Names of every legacy command flagged agent_callable:true in the
 * sidecar. Includes aliases (each alias gets its own sidecar entry to
 * preserve symmetric documentation). Used by hayba_invoke's ue_legacy
 * allowlist.
 */
export function listAgentCallableLegacyCommands(): Set<string> {
  const out = new Set<string>();
  for (const [name, entry] of Object.entries(sidecar.commands)) {
    if (entry.agent_callable) out.add(name);
  }
  return out;
}

// mcp_server/src/cli/spec.ts
import { load as loadYaml } from 'js-yaml';

/** One command sent over the same TCP seam every MCP tool uses
 *  (`executeCommand` in tool-executor.ts). `cmd` is a wire command name the
 *  plugin implements — NOT an MCP tool name (see docs/WORKFLOW-improving-the-mcp.md
 *  §3b: tool names and command names are different namespaces). `name` is an
 *  optional human label for log lines; it has no effect on execution. */
export interface CliStep {
  cmd: string;
  params?: Record<string, unknown>;
  name?: string;
}

export interface CliSpec {
  version: 1;
  steps: CliStep[];
}

export class SpecParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecParseError';
  }
}

/** True when `filename` looks like YAML by extension. Content sniffing is
 *  deliberately not attempted — JSON is valid YAML, so guessing from content
 *  alone is ambiguous; the extension is the one unambiguous signal a caller
 *  controls. */
function looksLikeYaml(filename: string | undefined): boolean {
  if (!filename) return false;
  return /\.ya?ml$/i.test(filename);
}

/** Parse and structurally validate a CLI spec. Accepts JSON or YAML — format
 *  is chosen by `filename` extension when given, otherwise JSON is tried
 *  first and YAML is the fallback (a YAML document that happens to also be
 *  valid JSON parses identically either way, so this only matters for
 *  non-JSON YAML with no filename hint, e.g. stdin).
 *
 *  Throws {@link SpecParseError} with a message naming exactly what is wrong
 *  — malformed syntax, wrong top-level shape, or a step missing `cmd` — never
 *  a bare parser exception. */
export function parseSpec(raw: string, filename?: string): CliSpec {
  let parsed: unknown;
  const yamlFirst = looksLikeYaml(filename);

  const tryJson = (): unknown => JSON.parse(raw);
  const tryYaml = (): unknown => loadYaml(raw);

  try {
    parsed = yamlFirst ? tryYaml() : tryJson();
  } catch (firstErr) {
    try {
      parsed = yamlFirst ? tryJson() : tryYaml();
    } catch {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      throw new SpecParseError(`could not parse spec as JSON or YAML: ${msg}`);
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SpecParseError('spec must be an object with a "steps" array (got ' + describeType(parsed) + ')');
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.steps)) {
    throw new SpecParseError('spec.steps must be an array');
  }
  if (obj.steps.length === 0) {
    throw new SpecParseError('spec.steps must contain at least one step');
  }

  const steps: CliStep[] = obj.steps.map((raw, i) => validateStep(raw, i));

  return { version: 1, steps };
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

function validateStep(raw: unknown, index: number): CliStep {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SpecParseError(`step[${index}] must be an object (got ${describeType(raw)})`);
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.cmd !== 'string' || s.cmd.trim().length === 0) {
    throw new SpecParseError(`step[${index}] is missing a non-empty "cmd" string`);
  }
  if (s.params !== undefined && (s.params === null || typeof s.params !== 'object' || Array.isArray(s.params))) {
    throw new SpecParseError(`step[${index}].params must be an object when present`);
  }
  if (s.name !== undefined && typeof s.name !== 'string') {
    throw new SpecParseError(`step[${index}].name must be a string when present`);
  }
  return {
    cmd: s.cmd,
    params: (s.params as Record<string, unknown> | undefined) ?? {},
    name: s.name as string | undefined,
  };
}

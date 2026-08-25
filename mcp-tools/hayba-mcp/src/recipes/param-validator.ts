// mcp-tools/hayba-mcp/src/recipes/param-validator.ts
//
// Runtime validation + default-filling for a RecipeParam[] against a
// caller-supplied values bag. Centralised so the MCP `run` tool and
// internal runRecipe calls share one code path.

import type { RecipeParam, RecipeParamValues } from './types.js';

export type ValidateResult =
  | { ok: true; values: RecipeParamValues }
  | { ok: false; reason: string };

export function validateAndCoerceParams(
  params: RecipeParam[],
  input: RecipeParamValues,
): ValidateResult {
  const known = new Set(params.map(p => p.id));
  for (const k of Object.keys(input)) {
    if (!known.has(k)) return { ok: false, reason: `unknown param "${k}"` };
  }

  const out: RecipeParamValues = {};
  for (const p of params) {
    const provided = Object.prototype.hasOwnProperty.call(input, p.id);
    let v = provided ? input[p.id] : (('default' in p ? (p as { default?: unknown }).default : undefined));

    if (v === undefined) {
      if (p.required) return { ok: false, reason: `missing required param "${p.id}"` };
      continue;
    }

    const err = checkParam(p, v);
    if (err) return { ok: false, reason: `param "${p.id}": ${err}` };
    out[p.id] = v;
  }
  return { ok: true, values: out };
}

function checkParam(p: RecipeParam, v: unknown): string | null {
  switch (p.type) {
    case 'float':
    case 'int': {
      if (typeof v !== 'number' || Number.isNaN(v)) return `expected number, got ${typeof v}`;
      if (p.type === 'int' && !Number.isInteger(v)) return 'expected integer';
      if (p.range) {
        const [lo, hi] = p.range;
        if (v < lo || v > hi) return `out of range [${lo}, ${hi}]`;
      }
      return null;
    }
    case 'bool':
      return typeof v === 'boolean' ? null : `expected boolean, got ${typeof v}`;
    case 'string':
      if (typeof v !== 'string') return `expected string, got ${typeof v}`;
      if (p.maxLength != null && v.length > p.maxLength) return `exceeds maxLength=${p.maxLength}`;
      return null;
    case 'enum':
      if (typeof v !== 'string') return 'expected string';
      return p.options.some(o => o.value === v) ? null : `not in options`;
    case 'color':
      return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? null : 'expected "#RRGGBB" hex';
    case 'actor_ref':
    case 'asset_ref':
      return typeof v === 'string' && v.length > 0 ? null : 'expected non-empty path string';
    case 'vector3':
      if (!Array.isArray(v) || v.length !== 3 || !v.every(n => typeof n === 'number')) return 'expected [x,y,z] number tuple';
      return null;
    case 'transform':
      if (typeof v !== 'object' || v === null) return 'expected object';
      // shallow check; the executor is trusted to deep-validate if it cares
      return null;
  }
}

// Runtime registry of Zod schemas keyed by command name. Populated at
// registration time by index.ts (regardless of Code Mode), so that
// get_tool_signature can derive parameter documentation from the actual
// shape used to validate inputs — instead of a hand-maintained dict that
// drifts every time a tool changes.

import { z, type ZodRawShape, type ZodTypeAny } from 'zod';

export type Cost = 'low' | 'medium' | 'high';

export type DerivedSignature = {
  params: Record<string, string>;
  returns: string;
  cost: Cost;
};

type RegistryEntry = {
  shape: ZodRawShape;
  cost: Cost;
  returns: string;
};

const REGISTRY = new Map<string, RegistryEntry>();

export function recordSchema(name: string, entry: RegistryEntry): void {
  REGISTRY.set(name, entry);
}

export function listRecordedCommands(): string[] {
  return Array.from(REGISTRY.keys());
}

export function deriveSignature(name: string): DerivedSignature | null {
  const e = REGISTRY.get(name);
  if (!e) return null;
  return {
    params: shapeToParamDoc(e.shape),
    returns: e.returns,
    cost: e.cost,
  };
}

// Walk one ZodType to produce a short human-readable parameter description.
// Mirrors the style of the hand-maintained dict: type first, then "(required)"
// or "(optional)", with describe() text appended when present.
function describeZod(t: ZodTypeAny): string {
  // Unwrap optionals/defaults to reach the inner type, but remember we did.
  let optional = false;
  let inner: ZodTypeAny = t;
  // ZodOptional / ZodDefault / ZodNullable all expose ._def.innerType
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodDefault ||
    inner instanceof z.ZodNullable
  ) {
    if (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) optional = true;
    inner = (inner as any)._def.innerType;
  }
  // ZodEffects (preprocess/refine) wraps a schema.
  while (inner instanceof z.ZodEffects) {
    inner = (inner as any)._def.schema;
  }

  let typeStr: string;
  if (inner instanceof z.ZodString) typeStr = 'string';
  else if (inner instanceof z.ZodNumber) typeStr = 'number';
  else if (inner instanceof z.ZodBoolean) typeStr = 'bool';
  else if (inner instanceof z.ZodEnum) typeStr = (inner._def.values as string[]).map(v => `"${v}"`).join('|');
  else if (inner instanceof z.ZodTuple) {
    const items = (inner._def.items as ZodTypeAny[]).map(describeZod).join(',');
    typeStr = `[${items}]`;
  } else if (inner instanceof z.ZodArray) {
    typeStr = `${describeZod(inner._def.type)}[]`;
  } else if (inner instanceof z.ZodObject) {
    typeStr = 'object';
  } else if (inner instanceof z.ZodAny || inner instanceof z.ZodUnknown) {
    typeStr = 'any';
  } else {
    typeStr = inner._def?.typeName?.replace(/^Zod/, '').toLowerCase() ?? 'any';
  }

  const qualifier = optional ? '(optional)' : '(required)';
  const desc = (t as any)._def?.description ?? (inner as any)._def?.description;
  return desc ? `${typeStr} ${qualifier} — ${desc}` : `${typeStr} ${qualifier}`;
}

function shapeToParamDoc(shape: ZodRawShape): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(shape)) {
    out[k] = describeZod(v as ZodTypeAny);
  }
  return out;
}

export function getRawShape(name: string): ZodRawShape | null {
  return REGISTRY.get(name)?.shape ?? null;
}

// Zod schema mirroring the TS types in types.ts. Used to validate JSON
// specs loaded from disk and from URL imports. The discriminated union
// on `type` matches the SliverParam shape exactly.

import { z } from 'zod';
import type { SliverSpec } from './types.js';

const reverseDns = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;

const rangePair = z.tuple([z.number(), z.number()]);

const paramBase = { id: z.string().min(1), label: z.string().optional(), required: z.boolean().optional() };

const paramFloat   = z.object({ ...paramBase, type: z.literal('float'),     range: rangePair.optional(), step: z.number().optional(), default: z.number().optional() });
const paramInt     = z.object({ ...paramBase, type: z.literal('int'),       range: rangePair.optional(), step: z.number().optional(), default: z.number().int().optional() });
const paramBool    = z.object({ ...paramBase, type: z.literal('bool'),      default: z.boolean().optional() });
const paramString  = z.object({ ...paramBase, type: z.literal('string'),    maxLength: z.number().int().positive().optional(), default: z.string().optional() });
const paramEnum    = z.object({ ...paramBase, type: z.literal('enum'),      options: z.array(z.object({ value: z.string(), label: z.string().optional() })).min(1), default: z.string().optional() });
const paramColor   = z.object({ ...paramBase, type: z.literal('color'),     default: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });
const paramActor   = z.object({ ...paramBase, type: z.literal('actor_ref'), class_filter: z.string().optional() });
const paramAsset   = z.object({ ...paramBase, type: z.literal('asset_ref'), class_filter: z.string().optional() });
const paramVec3    = z.object({ ...paramBase, type: z.literal('vector3'),   range: z.array(rangePair).length(3).optional(), default: z.tuple([z.number(), z.number(), z.number()]).optional() });
const paramXform   = z.object({ ...paramBase, type: z.literal('transform'), default: z.object({
  location: z.tuple([z.number(), z.number(), z.number()]),
  rotation: z.tuple([z.number(), z.number(), z.number()]),
  scale:    z.tuple([z.number(), z.number(), z.number()]),
}).optional() });

const param = z.discriminatedUnion('type', [
  paramFloat, paramInt, paramBool, paramString, paramEnum,
  paramColor, paramActor, paramAsset, paramVec3, paramXform,
]);

const determinism = z.object({
  pure: z.boolean(),
  declared_outputs: z.array(z.string()),
  side_effects: z.array(z.string()),
  reads: z.array(z.string()).default([]),
  seed_param: z.string().nullable(),
});

const requirement = z.object({
  primitive: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  binding: z.object({
    asset: z.string().optional(),
    tag: z.object({ axis: z.string(), value: z.string() }).optional(),
  }),
  hard: z.boolean().optional(),
  note: z.string().optional(),
});

export const sliverSpecSchema = z.object({
  id: z.string().regex(reverseDns, 'id must be reverse-DNS like com.hayba.composition.frame_target'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver MAJOR.MINOR.PATCH'),
  category: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  author: z.string().min(1),
  params: z.array(param).superRefine((arr, ctx) => {
    const seen = new Set<string>();
    for (const p of arr) {
      if (seen.has(p.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate param id "${p.id}"` });
      }
      seen.add(p.id);
    }
  }),
  executor: z.object({ kind: z.string().min(1) }),
  determinism,
  requires: z.array(requirement).optional(),
});

export type ParseResult =
  | { ok: true; spec: SliverSpec }
  | { ok: false; reason: string };

export function parseSliverSpec(input: unknown): ParseResult {
  const r = sliverSpecSchema.safeParse(input);
  if (r.success) return { ok: true, spec: r.data as SliverSpec };
  const first = r.error.issues[0];
  const path = first.path.join('.') || '(root)';
  return { ok: false, reason: `${path}: ${first.message}` };
}

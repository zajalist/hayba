// material_from_textures — assemble a PBR material from a downloaded map set.
//
// An ambientCG or PolyHaven download lands as a pile of textures. Until now the
// only thing to do with them was wire a material by hand, one TextureSample at
// a time, which is most of the reason texture acquisition never felt useful.
//
// Composed from commands that already exist (material_create, material_add_node,
// material_connect_nodes, material_compile) rather than a new C++ handler, so it
// needs no plugin rebuild and inherits their behaviour -- including the deferred
// compile, which is why the single material_compile at the end matters.
//
// The judgement lives in texture-set.ts and is pure. This file is the plumbing.

import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import { classifyTextureSet, planMaterial, type MaterialPlan } from './texture-set.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['creates_asset', 'modifies_asset'],
  when: 'you have imported a set of PBR textures and want a material wired from them',
  not_when: 'you need one texture on an existing material — use material_set_param',
};

export const schema = z.object({
  textures: z
    .array(z.string().min(1))
    .min(1)
    .describe('Imported texture asset paths. Map roles are read from the file names (Color/Normal/Roughness/...)'),
  package_path: z.string().min(1).describe('UE content path for the new material'),
  name: z.string().min(1).describe('Name of the material asset'),
  dry_run: z
    .boolean()
    .optional()
    .describe('Return the classification and the graph that would be built, without creating anything'),
});

export type MaterialFromTexturesParams = z.infer<typeof schema>;

/** Left-to-right, one row per map, so the graph is readable when opened. */
const NODE_X = -400;
const ROW_HEIGHT = 260;

export interface MaterialFromTexturesResult {
  ok: boolean;
  material?: string;
  plan: MaterialPlan;
  wired: string[];
  /** Steps that failed. A partly-wired material is reported as such, never as
   *  a success -- the asset exists either way and the caller has to know. */
  errors: string[];
  dry_run?: true;
}

export async function materialFromTextures(
  params: MaterialFromTexturesParams,
): Promise<MaterialFromTexturesResult> {
  const plan = planMaterial(classifyTextureSet(params.textures));

  if (plan.nodes.length === 0) {
    return {
      ok: false,
      plan,
      wired: [],
      errors: [
        `None of the ${params.textures.length} texture(s) matched a known map naming convention, so there is nothing to wire. Unrecognised: ${plan.unrecognised.join(', ')}`,
      ],
    };
  }

  if (params.dry_run) {
    return { ok: true, plan, wired: [], errors: [], dry_run: true };
  }

  const errors: string[] = [];
  const created = await executeCommand('material_create', {
    package_path: params.package_path,
    name: params.name,
  });
  const materialPath = (created as { path?: string } | undefined)?.path
    ?? `${params.package_path.replace(/\/$/, '')}/${params.name}`;

  const wired: string[] = [];
  for (const [i, node] of plan.nodes.entries()) {
    try {
      const added = await executeCommand('material_add_node', {
        material_path: materialPath,
        expression_class: 'MaterialExpressionTextureSample',
        node_pos: [NODE_X, i * ROW_HEIGHT],
        // SamplerType is a reflection passthrough, so it is the real
        // UPROPERTY name in PascalCase -- `sampler_type` is accepted, ignored,
        // and reported only in unknown_props. Verified against a live editor.
        properties: { texture: node.texture, SamplerType: node.samplerType },
      });
      const reply = added as
        { node_id?: string; id?: string; unknown_props?: string[] } | undefined;
      const nodeId = reply?.node_id ?? reply?.id;
      if (!nodeId) {
        errors.push(`${node.role}: the node was added but no id came back, so it could not be connected`);
        continue;
      }

      // material_add_node returns ok:true even when a property name matched
      // nothing -- it reports the miss in unknown_props instead. A silently
      // unapplied SamplerType is the exact failure this tool exists to avoid,
      // so an unapplied property is an error here, not a footnote.
      if (reply?.unknown_props?.length) {
        errors.push(
          `${node.role}: ${reply.unknown_props.join(', ')} did not apply, so this sampler is not configured as intended`,
        );
      }

      await executeCommand('material_connect_nodes', {
        material_path: materialPath,
        from_node: nodeId,
        to_property: node.connectsTo,
      });
      wired.push(node.role);
    } catch (e) {
      errors.push(`${node.role}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // One compile at the end. The per-edit handlers deliberately save without
  // recompiling, so without this the material is assembled but never translated.
  try {
    await executeCommand('material_compile', { material_path: materialPath });
  } catch (e) {
    errors.push(`compile: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    ok: errors.length === 0,
    material: materialPath,
    plan,
    wired,
    errors,
  };
}

export const materialFromTexturesHandler: ToolHandler = async (args) => {
  const params = schema.parse(args);
  const result = await materialFromTextures(params);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    isError: !result.ok,
  };
};

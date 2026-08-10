import { z } from 'zod';
import type { ToolResult, SessionManager } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'configuring a master material: blend mode, domain, shading model, two-sided, opacity mask clip, or an allowlisted used_with_* shader usage',
  not_when:
    'setting parameters on a material instance (use material_set_param) or node properties (use material_set_node)',
  // Settings are staged and verified in memory. material_compile remains the
  // one guarded shader compile/save point for master materials.
};

export const MATERIAL_USAGE_KEYS = [
  'used_with_skeletal_meshes',
  'used_with_particle_sprites',
  'used_with_beam_trails',
  'used_with_mesh_particles',
  'used_with_static_lighting',
  'used_with_morph_targets',
  'used_with_spline_meshes',
  'used_with_instanced_static_meshes',
  'used_with_geometry_collections',
  'used_with_clothing',
  'used_with_niagara_sprites',
  'used_with_niagara_ribbons',
  'used_with_niagara_mesh_particles',
  'used_with_geometry_cache',
  'used_with_water',
  'used_with_hair_strands',
  'used_with_lidar_point_cloud',
  'used_with_nanite',
  'used_with_voxels',
  'used_with_volumetric_cloud',
  'used_with_heterogeneous_volumes',
  'used_with_static_mesh',
  'used_with_editor_compositing',
  'used_with_neural_networks',
  'used_with_mesh_deformer',
  'used_with_instanced_skinned_meshes',
  'used_with_curves',
] as const;

const usageKeys = new Set<string>(MATERIAL_USAGE_KEYS);
export const MATERIAL_USAGE_COMPATIBILITY_ALIASES = {
  bUsedWithSplineMeshes: 'used_with_spline_meshes',
} as const;
const compatibilityUsageKeys = new Set<string>(Object.keys(MATERIAL_USAGE_COMPATIBILITY_ALIASES));

const propertiesSchema = z
  .object({
    domain: z.string().min(1).optional(),
    blend_mode: z.string().min(1).optional(),
    shading_model: z.string().min(1).optional(),
    two_sided: z.boolean().optional(),
    opacity_mask_clip_value: z.number().finite().min(0).max(1).optional(),
    enable_tessellation: z.boolean().optional(),
    ...Object.fromEntries(MATERIAL_USAGE_KEYS.map((key) => [key, z.boolean().optional()])),
    bUsedWithSplineMeshes: z.boolean().optional(),
  })
  .strict()
  .refine((properties) => Object.keys(properties).length > 0, { message: 'properties must be non-empty' })
  .superRefine((properties, ctx) => {
    const keys = Object.keys(properties);
    if (keys.includes('used_with_spline_meshes') && keys.includes('bUsedWithSplineMeshes')) {
      ctx.addIssue({ code: 'custom', message: 'do not supply both spline usage aliases in one request' });
    }
    if (
      keys.some((key) => usageKeys.has(key) || compatibilityUsageKeys.has(key)) &&
      keys.some((key) => !usageKeys.has(key) && !compatibilityUsageKeys.has(key))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'submit usage flags separately from other material settings so usage changes remain atomic',
      });
    }
  })
  .describe('Strict allowlist of master-material settings and typed shader usage flags.');

export const schema = z.object({
  material_path: z.string().min(1).describe('Path to the master material asset'),
  properties: propertiesSchema.describe(
    'Material settings. Allowlisted boolean used_with_* flags are staged with verified readback; use used_with_spline_meshes:true for UE spline routes, then call material_compile to compile and save.',
  ),
});

export async function materialSetMaterialPropertyHandler(
  args: Record<string, unknown>,
  _session?: SessionManager,
): Promise<ToolResult> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_set_property', parsed.data as Record<string, unknown>);
  const reply = data as Record<string, unknown>;
  const applied = Array.isArray(reply.applied) ? reply.applied : [];
  const changed = Array.isArray(reply.changed) ? reply.changed : [];
  const requestedKeys = Object.keys(parsed.data.properties).map(canonicalUsageKey);
  const commonEvidenceMatches =
    reply.saved === false &&
    typeof reply.requires_compile === 'boolean' &&
    typeof reply.dirty === 'boolean' &&
    normalizedMaterialPackage(reply.material_path) === normalizedMaterialPackage(parsed.data.material_path) &&
    sameStringSet(applied, requestedKeys) &&
    changed.length === new Set(changed).size &&
    changed.every((key) => typeof key === 'string' && requestedKeys.includes(key)) &&
    (changed.length === 0 || (reply.requires_compile === true && reply.dirty === true));
  const requestedUsage = Object.entries(parsed.data.properties)
    .filter(([key]) => usageKeys.has(key) || compatibilityUsageKeys.has(key))
    .map(([key, value]) => [canonicalUsageKey(key), value] as const);
  if (requestedUsage.length > 0) {
    const readback = reply.usage_flags;
    const evidenceMatches =
      commonEvidenceMatches &&
      reply.usage_flags_verified === true &&
      typeof readback === 'object' &&
      readback !== null &&
      requestedUsage.every(([key, value]) => (readback as Record<string, unknown>)[key] === value);
    if (!evidenceMatches) {
      return {
        content: [
          {
            type: 'text',
            text: 'material_set_property: Unreal did not prove the requested usage flags were staged atomically with matching readback; treat the material as unverified.',
          },
        ],
        isError: true,
      };
    }
  } else {
    const readback = reply.readback;
    const evidenceMatches =
      commonEvidenceMatches &&
      reply.verified === true &&
      typeof readback === 'object' &&
      readback !== null &&
      Object.entries(parsed.data.properties).every(([key, value]) =>
        ordinaryReadbackMatches(value, (readback as Record<string, unknown>)[key]),
      );
    if (!evidenceMatches) {
      return {
        content: [
          {
            type: 'text',
            text: 'material_set_property: Unreal did not prove all requested settings were staged with correlated readback.',
          },
        ],
        isError: true,
      };
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function canonicalUsageKey(key: string): string {
  return MATERIAL_USAGE_COMPATIBILITY_ALIASES[key as keyof typeof MATERIAL_USAGE_COMPATIBILITY_ALIASES] ?? key;
}

function ordinaryReadbackMatches(requested: unknown, observed: unknown): boolean {
  if (typeof requested === 'number' && typeof observed === 'number') return Math.abs(requested - observed) <= 1e-6;
  return requested === observed;
}

function normalizedMaterialPackage(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().split('.', 1)[0]!.toLocaleLowerCase('en-US');
}

function sameStringSet(actual: unknown[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value) => typeof value === 'string') &&
    [...(actual as string[])].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

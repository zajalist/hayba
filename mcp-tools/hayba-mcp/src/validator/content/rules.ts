// Content rules: textures and static meshes.
//
// Every threshold is stated with its reason. "Too big" is not actionable; "4096
// square uncompressed is 64 MB, and it is a UI icon" is.

import type { ContentFinding, ContentRule, ContentRuleContext, MeshRow, TextureRow } from './types.js';
import type { Strictness } from '../config.js';
import type { ContentThresholds } from './types.js';

const TUNING: Record<Strictness, ContentThresholds> = {
  relaxed: {
    textureMemoryWarnKb: 32 * 1024,   // 32 MB — only the genuinely extreme
    textureMemoryErrorKb: 96 * 1024,
    largeTextureDim: 2048,
    meshTriWarn: 250_000,
    materialSlotWarn: 12,
  },
  standard: {
    // 8 MB is roughly a 2048² BC-compressed texture with mips. Above that you
    // are usually looking at an uncompressed or oversized source.
    textureMemoryWarnKb: 8 * 1024,
    textureMemoryErrorKb: 48 * 1024,
    largeTextureDim: 1024,
    meshTriWarn: 100_000,
    materialSlotWarn: 8,
  },
  strict: {
    textureMemoryWarnKb: 4 * 1024,
    textureMemoryErrorKb: 24 * 1024,
    largeTextureDim: 512,
    meshTriWarn: 50_000,
    materialSlotWarn: 4,
  },
};

export function resolveContentThresholds(s: Strictness): ContentThresholds {
  return TUNING[s];
}

const mb = (kb: number) => `${(kb / 1024).toFixed(1)} MB`;
const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

function textures(ctx: ContentRuleContext): TextureRow[] {
  return ctx.snapshot.textures ?? [];
}
function meshes(ctx: ContentRuleContext): MeshRow[] {
  return ctx.snapshot.meshes ?? [];
}

function finding(
  rule: Pick<ContentRule, 'id' | 'category' | 'severity'>,
  message: string,
  hint: string,
  asset?: string,
  data?: Record<string, unknown>,
): ContentFinding {
  return { ruleId: rule.id, category: rule.category, severity: rule.severity, asset, message, hint, data };
}

export const CONTENT_RULES: ContentRule[] = [
  // ══ Textures ══════════════════════════════════════════════════════════════
  {
    id: 'texture_memory_extreme',
    category: 'asset',
    severity: 'error',
    minStrictness: 'relaxed',
    title: 'A single texture is using an extreme amount of memory',
    needs: 'textures',
    evaluate: (ctx) => {
      const out: ContentFinding[] = [];
      for (const t of textures(ctx)) {
        if (t.memory_kb < ctx.thresholds.textureMemoryErrorKb) continue;
        out.push(
          finding(
            { id: 'texture_memory_extreme', category: 'asset', severity: 'error' },
            `${t.path} is ${mb(t.memory_kb)} on its own (${t.size_x}x${t.size_y}, ${t.format}).`,
            `One texture at this size is usually an uncompressed import or a source-resolution asset that was never downsized. Set a Maximum Texture Size on the asset, or give it a compression setting appropriate to its role. Current compression: ${t.compression}.`,
            t.path,
            { memory_kb: t.memory_kb, size_x: t.size_x, size_y: t.size_y, format: t.format, compression: t.compression },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'texture_memory_high',
    category: 'asset',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Texture is heavy for its role',
    needs: 'textures',
    evaluate: (ctx) => {
      const out: ContentFinding[] = [];
      for (const t of textures(ctx)) {
        // The error rule owns anything above its threshold.
        if (t.memory_kb >= ctx.thresholds.textureMemoryErrorKb) continue;
        if (t.memory_kb < ctx.thresholds.textureMemoryWarnKb) continue;
        out.push(
          finding(
            { id: 'texture_memory_high', category: 'asset', severity: 'warning' },
            `${t.path} uses ${mb(t.memory_kb)} (${t.size_x}x${t.size_y}).`,
            `Above ${mb(ctx.thresholds.textureMemoryWarnKb)} is worth justifying. If this is UI or a small prop, halving the dimensions quarters the memory.`,
            t.path,
            { memory_kb: t.memory_kb, size_x: t.size_x, size_y: t.size_y },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'texture_compression_mismatch',
    category: 'asset',
    severity: 'warning',
    minStrictness: 'relaxed',
    title: 'Compression does not match what the texture appears to be',
    needs: 'textures',
    evaluate: (ctx) => {
      const out: ContentFinding[] = [];
      for (const t of textures(ctx)) {
        // The audit flags this itself by comparing the asset name against the
        // pixel format, so the judgement about intent already happened engine-side.
        if (!t.outlier) continue;
        out.push(
          finding(
            { id: 'texture_compression_mismatch', category: 'asset', severity: 'warning' },
            `${t.path} is named like a colour or normal map but is stored as ${t.format}.`,
            `A normal map wants BC5 and a colour map BC1/BC7. The wrong setting either wastes memory or visibly degrades the result — banded normals are the usual symptom. Current compression setting: ${t.compression}.`,
            t.path,
            { format: t.format, compression: t.compression },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'texture_not_power_of_two',
    category: 'asset',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Texture dimensions are not powers of two',
    needs: 'textures',
    evaluate: (ctx) => {
      const out: ContentFinding[] = [];
      for (const t of textures(ctx)) {
        if (isPow2(t.size_x) && isPow2(t.size_y)) continue;
        out.push(
          finding(
            { id: 'texture_not_power_of_two', category: 'asset', severity: 'warning' },
            `${t.path} is ${t.size_x}x${t.size_y}, which is not a power of two.`,
            'Non-power-of-two textures cannot generate a full mip chain and are excluded from streaming, so they stay fully resident and alias at distance. Resize to the nearest power of two unless this is deliberately a UI atlas that is never minified.',
            t.path,
            { size_x: t.size_x, size_y: t.size_y },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'texture_ui_group_mismatch',
    category: 'asset',
    severity: 'info',
    minStrictness: 'standard',
    title: 'Texture looks like UI but is not in the UI LOD group',
    needs: 'textures',
    evaluate: (ctx) => {
      const out: ContentFinding[] = [];
      for (const t of textures(ctx)) {
        const looksUi = /(^|\/)(ui|hud|icon|menu)/i.test(t.path);
        if (!looksUi) continue;
        if (/ui/i.test(t.lod_group)) continue;
        out.push(
          finding(
            { id: 'texture_ui_group_mismatch', category: 'asset', severity: 'info' },
            `${t.path} sits in a UI path but its LOD group is ${t.lod_group}.`,
            'The UI texture group disables streaming and mip bias, which is what you want for something drawn at a fixed size — otherwise UI can render blurry for a frame after load.',
            t.path,
            { lod_group: t.lod_group },
          ),
        );
      }
      return out;
    },
  },

  // ══ Meshes ════════════════════════════════════════════════════════════════
  {
    id: 'mesh_missing_lods',
    category: 'asset',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Heavy mesh has no LODs',
    needs: 'meshes',
    evaluate: (ctx) => {
      const out: ContentFinding[] = [];
      for (const m of meshes(ctx)) {
        const noLods = m.missing_lods === true || m.lod_count <= 1;
        if (!noLods) continue;
        // A simple mesh does not need LODs; the cost only matters with triangles.
        if (m.tris_lod0 < ctx.thresholds.meshTriWarn) continue;
        out.push(
          finding(
            { id: 'mesh_missing_lods', category: 'asset', severity: 'warning' },
            `${m.path} has ${m.tris_lod0.toLocaleString()} triangles and only ${m.lod_count} LOD.`,
            'Every instance renders at full density at any distance. Generate LODs (or enable Nanite if the mesh qualifies) — this is the single biggest lever on triangle cost for scattered meshes.',
            m.path,
            { tris_lod0: m.tris_lod0, lod_count: m.lod_count, referencer_count: m.referencer_count },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'mesh_triangle_heavy',
    category: 'asset',
    severity: 'info',
    minStrictness: 'strict',
    title: 'Mesh is triangle-heavy even with LODs',
    needs: 'meshes',
    evaluate: (ctx) => {
      const out: ContentFinding[] = [];
      for (const m of meshes(ctx)) {
        if (m.tris_lod0 < ctx.thresholds.meshTriWarn) continue;
        if (m.lod_count <= 1) continue; // the missing-LOD rule owns that case
        out.push(
          finding(
            { id: 'mesh_triangle_heavy', category: 'asset', severity: 'info' },
            `${m.path} is ${m.tris_lod0.toLocaleString()} triangles at LOD0.`,
            'It has LODs, so this is a note rather than a problem. Worth checking the LOD0 screen size is small enough that the full density is rarely drawn.',
            m.path,
            { tris_lod0: m.tris_lod0, lod_count: m.lod_count },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'mesh_material_slot_count',
    category: 'asset',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Mesh has many material slots',
    needs: 'meshes',
    evaluate: (ctx) => {
      const out: ContentFinding[] = [];
      for (const m of meshes(ctx)) {
        if (m.material_slot_count <= ctx.thresholds.materialSlotWarn) continue;
        out.push(
          finding(
            { id: 'mesh_material_slot_count', category: 'asset', severity: 'warning' },
            `${m.path} has ${m.material_slot_count} material slots.`,
            'Each slot is a separate draw call per instance. For a mesh that gets scattered, merging materials into an atlas is usually a larger win than reducing triangles.',
            m.path,
            { material_slot_count: m.material_slot_count, referencer_count: m.referencer_count },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'mesh_unreferenced',
    category: 'asset',
    severity: 'info',
    minStrictness: 'strict',
    title: 'Mesh is not referenced by anything',
    needs: 'meshes',
    evaluate: (ctx) => {
      const out: ContentFinding[] = [];
      for (const m of meshes(ctx)) {
        if (m.referencer_count !== 0) continue;
        out.push(
          finding(
            { id: 'mesh_unreferenced', category: 'asset', severity: 'info' },
            `${m.path} has no referencers.`,
            'Nothing in the project points at it. That is fine for an asset you are about to use, and dead weight otherwise — confirm with asset_get_referencers before deleting, since references from unloaded levels can be missed.',
            m.path,
            { referencer_count: 0 },
          ),
        );
      }
      return out;
    },
  },
];

export function contentRulesById(): Map<string, ContentRule> {
  const m = new Map<string, ContentRule>();
  for (const r of CONTENT_RULES) m.set(r.id, r);
  return m;
}

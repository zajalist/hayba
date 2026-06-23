import { z } from 'zod';
import type { ToolResult, SessionManager } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

const json = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const invalid = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `Validation error: ${msg}` }], isError: true });

// ── texture_get_info ─────────────────────────────────────────────────────────
export const getInfoMeta: HaybaToolMeta = {
  cost: 'low', effects: [],
  when: 'inspecting a texture: size, format, mips, compression, lod group, srgb, never-stream, address modes',
  not_when: 'listing many textures — use texture_list',
};
export const getInfoSchema = z.object({ path: z.string().min(1).describe('Texture asset path, e.g. /Game/Tex/T_Rock') });
export async function textureGetInfoHandler(args: Record<string, unknown>, _s?: SessionManager): Promise<ToolResult> {
  const p = getInfoSchema.safeParse(args); if (!p.success) return invalid(p.error.message);
  return json(await executeCommand('texture_get_info', p.data as Record<string, unknown>));
}

// ── texture_set_compression (focused) ────────────────────────────────────────
export const setCompressionMeta: HaybaToolMeta = {
  cost: 'low', effects: ['modifies_asset'],
  when: 'changing a texture\'s compression (e.g. TC_Normalmap, TC_Masks, TC_Default) and optionally lod_group / srgb',
  not_when: 'setting other texture properties (mip gen, max size, filter, ...) — use texture_set_settings',
};
export const setCompressionSchema = z.object({
  path: z.string().min(1).describe('Texture asset path'),
  compression_settings: z.string().min(1).describe('TextureCompressionSettings, e.g. Normalmap / Masks / Default (TC_ prefix optional)'),
  lod_group: z.string().optional().describe('TextureGroup, e.g. World / WorldNormalMap (TEXTUREGROUP_ prefix optional)'),
  srgb: z.boolean().optional().describe('sRGB flag'),
});
export async function textureSetCompressionHandler(args: Record<string, unknown>, _s?: SessionManager): Promise<ToolResult> {
  const p = setCompressionSchema.safeParse(args); if (!p.success) return invalid(p.error.message);
  return json(await executeCommand('texture_set_compression', p.data as Record<string, unknown>));
}

// ── texture_set_settings (generic) ───────────────────────────────────────────
export const setSettingsMeta: HaybaToolMeta = {
  cost: 'low', effects: ['modifies_asset'],
  when: 'setting any texture properties at once — compression, mip gen, max size, never-stream, flip-green, filter, address modes, virtual texturing, lod bias',
  not_when: 'only changing compression — texture_set_compression is fine',
};
export const setSettingsSchema = z.object({
  path: z.string().min(1).describe('Texture asset path'),
  properties: z.record(z.string(), z.unknown())
    .refine((o) => Object.keys(o).length > 0, { message: 'properties must be non-empty' })
    .describe('Settings to set. Aliases: compression_settings, lod_group, srgb, never_stream, address_x, address_y, mip_gen_settings, max_texture_size, flip_green_channel, filter, virtual_texture_streaming, lod_bias (e.g. { compression_settings: "Normalmap", srgb: false, mip_gen_settings: "Sharpen4" }). Any UTexture UPROPERTY name also accepted.'),
});
export async function textureSetSettingsHandler(args: Record<string, unknown>, _s?: SessionManager): Promise<ToolResult> {
  const p = setSettingsSchema.safeParse(args); if (!p.success) return invalid(p.error.message);
  return json(await executeCommand('texture_set_settings', p.data as Record<string, unknown>));
}

// ── texture_list ─────────────────────────────────────────────────────────────
export const listMeta: HaybaToolMeta = {
  cost: 'low', effects: [],
  when: 'enumerating Texture2D assets (optionally under a path prefix)',
  not_when: 'inspecting one texture in detail — use texture_get_info',
};
export const listSchema = z.object({ path_prefix: z.string().optional().describe('Only list textures whose path starts with this, e.g. /Game/Tex') });
export async function textureListHandler(args: Record<string, unknown>, _s?: SessionManager): Promise<ToolResult> {
  const p = listSchema.safeParse(args); if (!p.success) return invalid(p.error.message);
  return json(await executeCommand('texture_list', p.data as Record<string, unknown>));
}

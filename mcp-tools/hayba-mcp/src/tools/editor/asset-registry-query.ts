import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import type { ToolHandler } from '../types.js';

function plausiblePackagePath(value: string): boolean {
  return (
    value.startsWith('/') &&
    value.length > 1 &&
    !value.endsWith('/') &&
    !value.includes('//') &&
    !value.includes('.') &&
    !value.includes('\\')
  );
}

export const schema = z.object({
  class_filter: z.string().trim().min(1).optional().describe('Exact asset class name, e.g. "StaticMesh"'),
  name_contains: z.string().trim().min(1).optional().describe('Case-insensitive asset-name substring'),
  path_prefix: z
    .string()
    .trim()
    .min(1)
    .refine(plausiblePackagePath, 'must be a long package path such as /Game/Meshes')
    .optional(),
  recursive: z.boolean().optional().default(true),
  limit: z.number().int().min(1).max(500).optional().default(50),
  offset: z.number().int().min(0).max(2_147_483_647).optional().default(0),
});

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'discovering project assets by class, name, or content path with stable native pagination',
  not_when: 'you already know the exact asset path and need detailed metadata or dependencies',
};

type AssetRow = { name: string; path: string; class: string };
type QueryResult = { ok: true; assets: AssetRow[]; total: number; has_more: boolean; next_offset: number };

function validResult(value: unknown, request: z.infer<typeof schema>): value is QueryResult {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (
    r.ok !== true ||
    !Array.isArray(r.assets) ||
    !Number.isInteger(r.total) ||
    (r.total as number) < 0 ||
    (r.total as number) > 2_147_483_647 ||
    typeof r.has_more !== 'boolean' ||
    !Number.isInteger(r.next_offset) ||
    (r.next_offset as number) < 0 ||
    (r.next_offset as number) > 2_147_483_647 ||
    r.assets.length > request.limit ||
    (r.total as number) < r.assets.length
  )
    return false;
  if (
    !r.assets.every(
      (a) =>
        !!a &&
        typeof a === 'object' &&
        typeof (a as AssetRow).name === 'string' &&
        typeof (a as AssetRow).path === 'string' &&
        typeof (a as AssetRow).class === 'string',
    )
  )
    return false;
  const assets = r.assets as AssetRow[];
  if (
    assets.some((row) => {
      if (!row.name || !row.class || !plausiblePackagePath(row.path)) return true;
      return row.path.slice(row.path.lastIndexOf('/') + 1) !== row.name;
    })
  )
    return false;
  const total = r.total as number;
  const expectedStart = Math.min(request.offset, total);
  const expectedLength = Math.min(request.limit, Math.max(total - expectedStart, 0));
  const nextOffset = expectedStart + assets.length;
  if (assets.length !== expectedLength || r.next_offset !== nextOffset || r.has_more !== nextOffset < total)
    return false;

  for (let i = 0; i < assets.length; i += 1) {
    const row = assets[i]!;
    if (request.class_filter && row.class !== request.class_filter) return false;
    if (
      request.name_contains &&
      !row.name.toLocaleLowerCase('en-US').includes(request.name_contains.toLocaleLowerCase('en-US'))
    )
      return false;
    if (request.path_prefix) {
      const slash = row.path.lastIndexOf('/');
      const folder = slash > 0 ? row.path.slice(0, slash) : '';
      const foldedFolder = folder.toLocaleLowerCase('en-US');
      const foldedPrefix = request.path_prefix.toLocaleLowerCase('en-US');
      const pathMatches = request.recursive
        ? foldedFolder === foldedPrefix || foldedFolder.startsWith(`${foldedPrefix}/`)
        : foldedFolder === foldedPrefix;
      if (!pathMatches) return false;
    }
    const previous = assets[i - 1];
    if (previous && (previous.path > row.path || (previous.path === row.path && previous.name > row.name)))
      return false;
  }
  return true;
}

export const assetRegistryQueryHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const data = await executeCommand<unknown>('asset_registry_query', parsed.data);
    if (!validResult(data, parsed.data)) {
      return {
        content: [{ type: 'text', text: 'asset_registry_query error: native response failed contract validation' }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    return {
      content: [
        { type: 'text', text: `asset_registry_query error: ${error instanceof Error ? error.message : String(error)}` },
      ],
      isError: true,
    };
  }
};

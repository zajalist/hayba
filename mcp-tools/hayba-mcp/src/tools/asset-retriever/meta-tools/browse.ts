import { z } from 'zod';
import { join } from 'node:path';
import type { AssetRetriever } from '../asset-retriever.js';
import type { Page } from '../asset-catalog.js';
import { runAfterTool } from '../../../validator/runner.js';
import { attachFindingsToValue } from '../../../validator/response.js';
import type { ValidatorFinding } from '../../../validator/rules.js';

export const assetBrowseSchema = {
  filter: z.object({
    path: z.string().optional(),
    class: z.string().optional(),
    tag: z.string().optional(),
    source: z.enum(['project', 'polyhaven', 'ambientcg', 'sketchfab', 'fab', 'unknown']).optional(),
  }).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
};

export interface AssetBrowseCtx { retriever: AssetRetriever; }

export type AssetBrowseResult = Page & { validator?: { findings: ValidatorFinding[] } };

export async function assetBrowseHandler(
  args: { filter?: { path?: string; class?: string; tag?: string; source?: 'project' | 'polyhaven' | 'ambientcg' | 'sketchfab' | 'fab' | 'unknown' }; offset?: number; limit?: number },
  ctx: AssetBrowseCtx,
): Promise<AssetBrowseResult> {
  let result: Page;
  try {
    result = await ctx.retriever.browse(args.filter ?? {}, args.offset ?? 0, args.limit ?? 50);
  } catch (e) {
    // Surface as the result so the asset_browse_describe_assets_missing rule
    // (which regex-matches "Unknown command: describe_assets") can fire.
    result = { total: 0, offset: args.offset ?? 0, limit: args.limit ?? 50, docs: [] };
    const errored = { error: e instanceof Error ? e.message : String(e) } as Record<string, unknown>;
    const findings = await runAfterTool({
      toolName: 'hayba_asset_browse',
      toolArgs: args as Record<string, unknown>,
      toolResult: errored,
      probe: null,
      scratchDir: join(process.cwd(), '.scratch'),
    });
    return attachFindingsToValue(result as unknown as Record<string, unknown>, findings) as unknown as AssetBrowseResult;
  }

  const findings = await runAfterTool({
    toolName: 'hayba_asset_browse',
    toolArgs: args as Record<string, unknown>,
    toolResult: result,
    probe: null,
    scratchDir: join(process.cwd(), '.scratch'),
  });
  return attachFindingsToValue(result as unknown as Record<string, unknown>, findings) as unknown as AssetBrowseResult;
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You want to enumerate assets by filter (path prefix, class, tag, source) without semantic ranking.',
  not_when: 'You have a semantic query — use hayba_asset_search.',
  pack: 'core',
};

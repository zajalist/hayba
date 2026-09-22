import { describe, expect, it } from 'vitest';
import { STATIC_TOOL_CATALOGUE, captureStaticToolCatalogue } from '../index.js';
import { isHeavyOp } from '../heavy-ops.js';
import { recordToolSchema } from '../register-tool.js';
import { listToolCategoriesHandler } from '../code-mode/list-tool-categories.js';
import { worldInspectDescriptor } from './world-inspect.js';
import { worldIngestDescriptor } from './world-ingest.js';
import { assetPrepareDescriptor } from '../asset/asset-prepare.js';

describe('world workflow registration', () => {
  it.each(['world_inspect', 'world_ingest', 'asset_inspect', 'asset_prepare', 'hayba_import_landscape', 'import_landscape'])(
    'exposes %s once in the shared eager/deferred catalogue', (name) => {
      expect(STATIC_TOOL_CATALOGUE.filter((tool) => tool.name === name)).toHaveLength(1);
      expect(captureStaticToolCatalogue({}).has(name)).toBe(true);
    },
  );

  it.each([worldInspectDescriptor, worldIngestDescriptor, assetPrepareDescriptor])(
    'registers the original $name descriptor without another schema', (descriptor) => {
      expect(STATIC_TOOL_CATALOGUE.find((tool) => tool.name === descriptor.name)).toBe(descriptor);
    },
  );

  it('keeps preparation inspection internal instead of publishing another asset inspector', () => {
    expect(STATIC_TOOL_CATALOGUE.some((tool) => tool.name === 'asset_inspect_preparation')).toBe(false);
  });

  it.each(['level_save', 'mesh_set_lod'])('preserves the public generated %s tool used by workflows', (name) => {
    expect(STATIC_TOOL_CATALOGUE.filter((tool) => tool.name === name)).toHaveLength(1);
  });

  it('uses heavy-operation handling for world ingestion', () => {
    expect(isHeavyOp('world_ingest')).toBe(true);
  });

  it('discovers world workflows and their legacy adapters together', async () => {
    for (const descriptor of STATIC_TOOL_CATALOGUE) recordToolSchema(descriptor);
    const response = await listToolCategoriesHandler({}, {});
    const result = JSON.parse(response.content[0]!.text) as { domains: Array<{ domain: string; callable: string[] }> };
    expect(result.domains.find((domain) => domain.domain === 'world')?.callable).toEqual(expect.arrayContaining([
      'world_inspect', 'world_ingest', 'hayba_import_landscape', 'import_landscape',
    ]));
    expect(result.domains.find((domain) => domain.domain === 'asset')?.callable).toEqual(expect.arrayContaining([
      'asset_inspect', 'asset_prepare',
    ]));
  });
});

// mcp-tools/hayba-mcp/src/tools/asset-sources/dag-hook.test.ts
import { describe, it, expect } from 'vitest';
import { setAssetDagSink, emitAssetWrite } from './shared.js';

describe('asset-source DAG hook', () => {
  it('emitAssetWrite forwards a verified write to the registered sink', () => {
    const seen: Array<{ uri: string }> = [];
    setAssetDagSink((uri) => seen.push({ uri }));
    emitAssetWrite('/Game/Imported/SM_Rock');
    expect(seen).toEqual([{ uri: 'ue://Game/Imported/SM_Rock' }]);
  });

  it('emitAssetWrite is a no-op when no sink is registered', () => {
    setAssetDagSink(null);
    expect(() => emitAssetWrite('/Game/X')).not.toThrow();
  });
});

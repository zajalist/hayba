import { afterEach, describe, expect, it } from 'vitest';
import { assetValidateHandler } from './asset-validate.js';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';

let ue: ScriptedUe;
afterEach(() => ue?.restore());

describe('asset validation workload boundary', () => {
  it.each([0, -1, 1.5, 1001, '100', null])('rejects invalid max_assets %s before dispatch', async (max_assets) => {
    ue = scriptedUe().replies('asset_validate', { valid: true });
    const result = await assetValidateHandler({ path: '/Game/A', max_assets }, {} as never);
    expect(result.isError).toBe(true);
    expect(ue.calls).toHaveLength(0);
  });

  it('preserves the explicit workload bound sent to the native validator', async () => {
    ue = scriptedUe().replies('asset_validate', { valid: false, status: 'not_validated' });
    await assetValidateHandler({ path: '/Game/A', max_assets: 7 }, {} as never);
    expect(ue.paramsFor('asset_validate')).toEqual({ path: '/Game/A', max_assets: 7 });
  });
});

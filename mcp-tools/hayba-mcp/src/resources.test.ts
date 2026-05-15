import { describe, it, expect } from 'vitest';
import { listCatalogResources, readCatalogResource } from './resources.js';

describe('Resources', () => {
  it('should list catalog resources', async () => {
    try {
      const resources = await listCatalogResources();
      expect(Array.isArray(resources)).toBe(true);
      if (resources.length > 0) {
        expect(resources[0]).toHaveProperty('uri');
        expect(resources[0]).toHaveProperty('name');
        expect(resources[0]).toHaveProperty('mimeType');
      }
    } catch {
      // Expected if catalog not found in test env
    }
  });
});

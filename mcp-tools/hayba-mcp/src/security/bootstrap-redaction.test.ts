import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bootstrap = readFileSync(join(packageRoot, 'src', 'bootstrap.ts'), 'utf8');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  bin: Record<string, string>;
  scripts: Record<string, string>;
};

describe('secret redaction installs before the server import graph', () => {
  it('routes the executable and start script through the bootstrap', () => {
    expect(manifest.bin['hayba-mcp']).toBe('./dist/bootstrap.js');
    expect(manifest.scripts.start).toBe('node dist/bootstrap.js');
  });

  it('installs redaction before dynamically importing the application', () => {
    const install = bootstrap.indexOf('installConsoleSecretRedaction();');
    const start = bootstrap.indexOf("await import('./index.js')");
    expect(install).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(install);
    expect(bootstrap).not.toMatch(/import\s+.*from\s+['"]\.\/index\.js['"]/);
  });
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/validate.ts',
        'src/registry.ts',
        'src/mcp.ts',
        'src/element-registry.ts',
        'src/kernel/**/*.ts',
      ],
      exclude: ['**/*.test.ts', 'src/kernel/elements/index.ts'],
    },
  },
});

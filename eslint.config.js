import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.js.map',
      '**/*.tsbuildinfo',
      '**/package-lock.json',
    ],
  },
  {
    files: ['**/*.mjs'],
    ignores: ['mcp-tools/hayba-mcp/scripts/audit-production-dependencies.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: [
      'website/**/*.js',
      'packages/architecture/demo/studio.js',
      'mcp-tools/pcgex/**/dashboard/js/**/*.js',
      'unreal/HaybaMCPToolkit/Resources/**/*.js',
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['mcp-tools/pcgex/**/dashboard/js/**/*.js'],
    languageOptions: { globals: { cytoscape: 'readonly' } },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-console': 'off',
    },
  },
);

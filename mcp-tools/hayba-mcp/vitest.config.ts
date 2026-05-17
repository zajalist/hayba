import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/gaea/**',           // Gaea surface is parked (gitignored source)
      '**/hayba-brainstorm-gaea*',
      '**/hayba-import-landscape*',
      '**/hayba-bake-sets-heightmap*',
      '**/hayba-bake-terrain*',
      '**/hayba-create-terrain*',
      '**/hayba-open-in-gaea*',
      '**/hayba-read-terrain-variables*',
      '**/hayba-set-terrain-variables*',
      '**/hayba-open-session*',
      '**/hayba-close-session*',
      '**/hayba-add-node*',
      '**/hayba-remove-node*',
      '**/hayba-connect-nodes*',
      '**/hayba-get-graph-state*',
      '**/hayba-get-parameters*',
      '**/hayba-set-parameter*',
      '**/hayba-list-node-types*',
      '**/hayba-cook-graph*',
      '**/search-gaea-archetypes*',
      '**/get-full-archetype-graph*',
      '**/query-gaea-knowledge*',
      '**/agent-registry*',  // Depends on gitignored gaea/memory
      '**/hayba-open-zone-painter*', // Requires running UE editor
    ],
  },
})

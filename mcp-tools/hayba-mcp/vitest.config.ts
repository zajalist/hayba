import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    // Kept short, and every entry has to be true.
    //
    // This list used to carry 23 patterns naming individual Gaea tools
    // (`**/hayba-cook-graph*`, `**/search-gaea-archetypes*`, …). Naming them one
    // by one hid what was actually going on — that the whole Gaea tool surface
    // is parked — and it swept up `src/gaea/` along with them via `**/gaea/**`,
    // silently excluding 13 passing pure-logic tests that have nothing to do
    // with the parked tools. It also carried an `agent-registry` entry annotated
    // "depends on gitignored gaea/memory" for source that no longer exists, and
    // a `**/gaea/**` comment claiming the source was gitignored while 79 files
    // under src/gaea were tracked.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // The Gaea *tool* surface is parked: its registration block was commented
      // out in src/tools/index.ts and has since been deleted, so these files
      // test handlers that nothing can reach. They stay until the terrain
      // integration phase brings the surface back — at which point delete these
      // lines rather than adding to them.
      //
      // `tests/gaea/memory/**` is carved OUT of this list (issue #355): HaybaMemory
      // is no longer parked-and-unreachable — it backs the memory_* tools
      // registered in src/tools/memory/index.ts — so its test now runs like any
      // other live test. A blanket '**/tests/gaea/**' would silently re-exclude it.
      'tests/gaea/gaea-launcher.test.ts',
      'tests/gaea/session.test.ts',
      'tests/gaea/swarmhost-mutations.test.ts',
      'tests/gaea/swarmhost-variables.test.ts',
      'tests/gaea/swarmhost.test.ts',
      'tests/gaea/templates.test.ts',
      'tests/gaea/tools/**',
      'tests/gaea/types.test.ts',
    ],
  },
})

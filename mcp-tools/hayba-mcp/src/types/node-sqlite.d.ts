// Fallback ambient declaration for Node's built-in `node:sqlite` module.
//
// `match-pin-names.ts`, `query-pcgex-docs.ts`, and `scrape-node-registry.ts`
// pull `DatabaseSync` out of `node:sqlite` via
//   createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
// so `tsc --noEmit` needs a type for that module. Typings ship with
// @types/node >= 22.5, but any older/stale install in a developer's
// node_modules (the monorepo also hoists a transitive @types/node@20 to the
// root) leaves the module untyped and produces:
//   TS2307: Cannot find module 'node:sqlite' or its corresponding type declarations.
// That broke the pre-commit `tsc` gate for the whole team, so every commit
// used `--no-verify`.
//
// This shorthand declaration makes the typecheck independent of how fresh the
// installed @types/node happens to be: when current types are present they
// win (verified: this file does not conflict with @types/node@24's
// sqlite.d.ts); when they're missing, the module resolves as `any` instead of
// failing the build. Remove once every workspace is guaranteed to resolve a
// recent @types/node.
declare module 'node:sqlite';

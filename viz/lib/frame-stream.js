// Thin re-export — the real decoder lives at packages/frame-stream/index.js
// so tectonic-explorer can share the exact same module. Anything importing
// from `viz/lib/frame-stream.js` keeps working unchanged.
export * from '../../packages/frame-stream/index.js';

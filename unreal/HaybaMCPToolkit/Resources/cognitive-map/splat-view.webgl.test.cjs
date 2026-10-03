const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let nextBuffer = 0;
const uploads = [], draws = [], depthModes = [];
const gl = {
  VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
  DEPTH_TEST: 5, LEQUAL: 6, BLEND: 7, SRC_ALPHA: 8, ONE_MINUS_SRC_ALPHA: 9,
  COLOR_BUFFER_BIT: 10, DEPTH_BUFFER_BIT: 11, ARRAY_BUFFER: 12, DYNAMIC_DRAW: 13,
  STATIC_DRAW: 14, FLOAT: 15, POINTS: 16,
  createShader: () => ({}), shaderSource() {}, compileShader() {}, getShaderParameter: () => true,
  getShaderInfoLog: () => '', createProgram: () => ({}), attachShader() {}, linkProgram() {},
  getProgramParameter: () => true, getProgramInfoLog: () => '', deleteShader() {},
  getAttribLocation: (_, name) => ({ position: 0, normal: 1, color: 2 })[name],
  getUniformLocation: (_, name) => name, enable() {}, disable() {}, depthFunc() {}, blendFunc() {},
  viewport() {}, clearColor() {}, clear() {}, useProgram() {}, uniformMatrix4fv() {}, uniform1f() {},
  createBuffer: () => ({ id: ++nextBuffer }), deleteBuffer() {},
  bindBuffer(_, buffer) { this.bound = buffer; },
  bufferData(_, source) { uploads.push({ buffer: this.bound, bytes: source?.byteLength ?? source }); },
  bufferSubData(_, offset, data) { uploads.push({ buffer: this.bound, bytes: data.byteLength, offset }); },
  enableVertexAttribArray() {}, vertexAttribPointer() {},
  drawArrays(_, start, count) { draws.push({ buffer: this.bound, start, count }); },
  depthMask(enabled) { depthModes.push(enabled); },
};
function element() {
  return { hidden: false, textContent: '', children: [], style: {}, clientWidth: 800, clientHeight: 600,
    classList: { add() {}, remove() {}, toggle() {} },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
    setAttribute() {}, remove() {}, setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    getContext(kind) { return kind === 'webgl' ? gl : null; },
  };
}
const elements = new Map(), frames = [];
const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
  createElement: element, createTextNode: text => ({ textContent: text }) };
const window = { __haybaTest: true, devicePixelRatio: 1, addEventListener() {}, location: { href: '' },
  setTimeout: () => 1, clearTimeout() {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'splat-view.js'), 'utf8'),
  { document, window, requestAnimationFrame(fn) { frames.push(fn); } }, { filename: 'splat-view.js' });
const { state, tileScopesForPoint, selectScope } = window.__haybaTest;
const baseRow = [0, 0, 0, 0, 0, 1, 180, 170, 150, 0, 2, -1];
window.haybaLoadGeometry({ generation: 1, originCm: [0, 0, 0], nativeSelection: true });
window.haybaAppendGeometry(1, {
  actors: [{ path: '/Game/World/Stall', label: 'Stall' }],
  nodes: [{ id: 'world', kind: 'world', parentIndex: -1 },
    { id: 'actor:stall', kind: 'actor', parentIndex: 0, actorIndex: 0, tags: ['market'] },
    { id: 'mesh:stall', kind: 'static_mesh_component', parentIndex: 1, actorIndex: 0,
      meshAsset: '/Game/Props/Stall' }],
  clusters: [{ level: 0, parentIndex: -1 }],
  boundsCm: { valid: true, min: [0, 0, 0], max: [1000, 1000, 1000] },
  coverage: { actorCount: 1, stopReasons: [], unsupportedByKind: {} },
});
window.haybaAppendSplats(1, Array.from({ length: 1024 }, (_, i) =>
  [(i % 32) * 30, Math.floor(i / 32) * 30, 0, ...baseRow.slice(3)]));
for (let page = 0; page < 64; page++) window.haybaAppendDepthSplats(1,
  Array.from({ length: 128 }, (_, i) => [i * 4, page * 4, 0, 0, 0, 1, 120, 150, 170, -1, -1, -1]));
assert.equal(state.chunks.length, 2, '64 small depth pages share one draw buffer');
window.haybaGeometryDone(1, { worldState: 'complete' });
const tileId = 'tile:2:0:0:0';
window.haybaTileBegin(1, { tileId, lod: 2, originCm: [0, 0, 0],
  boundsCm: { valid: true, min: [0, 0, 0], max: [1000, 1000, 1000] } });
for (let pageId = 0; pageId < 8; pageId++) window.haybaTileAppend(1, tileId, {
  pageId, chunkIndex: 0, originCm: [0, 0, 0],
  actors: [{ path: '/Game/World/Stall', label: 'Stall' }],
  nodes: [{ id: 'world', kind: 'world', parentIndex: -1 },
    { id: 'actor:stall', kind: 'actor', parentIndex: 0, actorIndex: 0, tags: ['market'] },
    { id: 'mesh:stall', kind: 'static_mesh_component', parentIndex: 1, actorIndex: 0,
      meshAsset: '/Game/Props/Stall' }],
  splats: Array.from({ length: 1024 }, (_, i) =>
    [(i % 32) * 30, Math.floor(i / 32) * 30, pageId * 50, ...baseRow.slice(3)]),
});
window.haybaTileDone(1, { tileId, pointCount: 8192, partial: false });
const tile = state.tiles.get(tileId);
assert.equal(tile.chunks.length, 8);
assert.equal(tile.renderChunk.count, 8192);
state.userMoved = true; state.target = [500, 500, 250]; state.distance = 1500;
while (frames.length) frames.shift()();
const tileDraws = draws.filter(draw => draw.buffer === tile.renderChunk.buffer);
assert.equal(tileDraws.length, 1, 'eight page callbacks become one tile draw call');
assert.equal(tileDraws[0].count, 8192);

const scopes = tileScopesForPoint({ chunk: tile.chunks[0], index: 0 });
state.selectionScopes = scopes;
const uploadStart = uploads.length;
selectScope(scopes.findIndex(scope => scope.key === 'tag:market'));
const selectionUploads = uploads.slice(uploadStart);
assert.equal(selectionUploads.some(upload => upload.buffer === tile.renderChunk.buffer ||
  state.chunks.some(chunk => chunk.buffer === upload.buffer)), false,
  'changing semantic group uploads compact selected buffers, never full geometry buffers');
draws.length = 0;
while (frames.length) frames.shift()();
assert.equal(draws.filter(draw => draw.buffer === tile.renderChunk.buffer).length, 1,
  'selection no longer doubles the full tile draw');
assert.ok(draws.some(draw => tile.chunks.some(chunk => chunk.selectedBuffer === draw.buffer)),
  'the selected subset receives its own visible pass');
assert.deepEqual(depthModes.slice(-2), [false, true], 'selection keeps depth testing and restores depth writes');
console.log('splat-view WebGL: coalesced depth, one tile draw, compact selection uploads: passed');

assert.equal(window.haybaFocusTile('tile:2:0:0:0'), true);
assert.equal(state.distance, 1500);
assert.deepEqual([...state.target], [500, 500, 500]);
assert.equal(window.haybaFocusTile('tile:2:bad'), false);
assert.equal(window.haybaFocusTile(tileId, 'stale-capture'), false);
state.pendingTileSelect = { tileId, pageId: 0, actorIndex: 0,
  actorPath: '/Game/World/Stall', retries: 0 };
window.haybaTileSelectionResult(1, { tileId, pageId: 0, actorIndex: 0,
  selected: false, reason: 'not_cached' });
assert.equal(state.pendingTileSelect.retries, 1);
assert.equal(window.location.href, 'hayba-scene-map://refine/1/2/0/0/0');
window.haybaTileBegin(1, { tileId, captureId: 'new-capture', lod: 2, originCm: [0, 0, 0],
  boundsCm: { valid: true, min: [0, 0, 0], max: [1000, 1000, 1000] } });
window.haybaTileAppend(1, tileId, { pageId: 5, chunkIndex: 0, originCm: [0, 0, 0],
  actors: [{ path: '/Game/World/Decoy' }, { path: '/Game/World/Stall' }],
  nodes: [{ id: 'world', kind: 'world', parentIndex: -1 },
    { id: 'actor:stall', kind: 'actor', parentIndex: 0, actorIndex: 1 }],
  splats: [[500, 500, 500, 0, 0, 1, 180, 170, 150, 1, 1, -1]] });
window.haybaTileDone(1, { tileId, captureId: 'new-capture', pointCount: 1, partial: false });
assert.equal(window.location.href, 'hayba-scene-map://select-tile/1/2/0/0/0/5/1',
  'retry resolves the refreshed actor path, not the old page-local index');
window.haybaTileSelectionResult(1, { tileId, pageId: 5, actorIndex: 1,
  selected: true, reason: 'selected' });
assert.equal(state.pendingTileSelect, null);
assert.equal(window.haybaFocusTile(tileId, 'new-capture'), true);
state.pendingTileSelect = { tileId, pageId: 5, actorIndex: 1,
  actorPath: '/Game/World/Stall', retries: 1 };
window.haybaTileSelectionResult(1, { tileId, pageId: 5, actorIndex: 1,
  selected: false, reason: 'source_unavailable' });
assert.equal(state.pendingTileSelect, null);
assert.equal(elements.get('message').children[0].textContent, 'Source unavailable',
  'failed tile selection is visible to the user');
console.log('splat-view focus navigation and fail-closed tile selection retry: passed');

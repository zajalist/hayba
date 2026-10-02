const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
  return {
    hidden: false, textContent: '', children: [], style: {}, clientWidth: 800, clientHeight: 600,
    classList: { add() {}, remove() {}, toggle() {} },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    addEventListener() {}, setAttribute() {}, remove() {},
    getContext(kind) {
      if (kind === 'webgl') return null;
      return { fillRect() {}, beginPath() {}, arc() {}, fill() {} };
    },
  };
}

const elements = new Map();
const document = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
  createElement: element,
  createTextNode: text => ({ textContent: text }),
};
const window = { __haybaTest: true, devicePixelRatio: 1, addEventListener() {}, location: { href: '' } };
const script = fs.readFileSync(path.join(__dirname, 'splat-view.js'), 'utf8');
vm.runInNewContext(script, { document, window, requestAnimationFrame() {} }, { filename: 'splat-view.js' });
const { state, lodOrder, lodCount } = window.__haybaTest;

const order = lodOrder(512);
assert.equal(order.length, 512);
assert.equal(new Set(order).size, 512);
assert.deepEqual([...order.slice(0, 4)], [0, 256, 128, 384]);

window.haybaLoadGeometry({ generation: 1, originCm: [0, 0, 0], boundsCm: { valid: false }, coverage: { unsupportedByKind: {} }, nativeSelection: true });
function appendPage(label, x) {
  window.haybaAppendGeometry(1, {
    actors: [{ label, path: `/World/${label}` }],
    nodes: [
      { kind: 'world', parentIndex: -1, sourceCount: 1, splatCount: 1 },
      { kind: 'actor', label, parentIndex: 0, actorIndex: 0, boundsCm: { valid: true, min: [x, 0, 0], max: [x, 0, 0] } },
    ],
    clusters: [
      { level: 0, parentIndex: -1, splatCount: 1, actorIndices: [0], nodeIndices: [1] },
      { level: 1, parentIndex: 0, splatCount: 1, actorIndices: [0], nodeIndices: [1] },
    ],
    boundsCm: { valid: true, min: [x, 0, 0], max: [x, 0, 0] },
    coverage: { actorCount: 1, selectedActorCount: 1, stopReasons: [], unsupportedByKind: {} },
  });
  window.haybaAppendSplats(1, [[x, 0, 0, 0, 0, 1, 180, 190, 200, 0, 1, 1]]);
}
appendPage('first', 0);
appendPage('second', 100);
assert.equal(state.count, 2);
assert.equal(state.actors.length, 2);
assert.equal(state.nodes[2].actorIndex, 1);
assert.equal(state.nodes[2].parentIndex, 0);
assert.equal(state.clusters[2].actorIndices[0], 1);
assert.equal(state.chunks[1].data[9], 1);
assert.equal(state.chunks[1].data[10], 2);
assert.equal(state.chunks[1].data[11], 2);
assert.equal(state.radius, 50);
assert.equal(state.target[0], 50, 'progressive bounds keep the untouched camera centered');
assert.equal(state.coverage.actorCount, 2);

// Invalid local source references must never become pickable global records.
window.haybaAppendSplats(1, [[0, 0, 0, 0, 0, 1, 0, 0, 0, 99, 1, 1]]);
assert.equal(state.count, 2);
window.haybaAppendSplats(1, [[100, 0, 0, 0, 0, 1, 180, 190, 200, 0, 1, -1]]);
assert.equal(state.count, 3, 'points remain visible when native cluster construction times out');
window.haybaGeometryDone(1, { partial: true, gaps: ['loaded_level_changed'], scannedActorSlots: 2, totalActorSlots: 3 });
assert.equal(state.done, true);
assert.ok(state.clusters.length > 1, 'completion creates one global spatial hierarchy');
for (const chunk of state.chunks) for (let i = 0; i < chunk.count; i++)
  assert.ok(chunk.data[i * 13 + 11] >= 0 && chunk.data[i * 13 + 11] < state.clusters.length);

// A dense sample set draws a distributed prefix when fitted, then all detail nearby.
state.count = 100000;
state.radius = 100;
state.distance = 250;
assert.equal(lodCount(512), 256);
state.distance = 50;
assert.equal(lodCount(512), 512);
console.log('splat-view progressive batches and LOD: passed');

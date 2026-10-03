const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let canvasArcCount = 0;
const frames = [];
function element() {
  return {
    hidden: false, textContent: '', children: [], style: {}, clientWidth: 800, clientHeight: 600,
    classList: { add() {}, remove() {}, toggle() {} },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }, setAttribute() {}, remove() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    getContext(kind) {
      if (kind === 'webgl') return null;
      return { fillRect() {}, beginPath() {}, arc() { canvasArcCount++; }, fill() {} };
    },
  };
}

const elements = new Map();
const document = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
  createElement: element,
  createTextNode: text => ({ textContent: text }),
};
const timers = new Map(); let nextTimer = 0;
let reloads = 0;
const window = { __haybaTest: true, devicePixelRatio: 1, addEventListener() {}, location: { href: '', reload() { reloads++; } },
  setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout(id) { timers.delete(id); } };
const script = fs.readFileSync(path.join(__dirname, 'splat-view.js'), 'utf8');
vm.runInNewContext(script, { document, window, requestAnimationFrame(callback) { frames.push(callback); } }, { filename: 'splat-view.js' });
const { state, lodOrder, lodCount, visibleChunkCounts, visibleRenderPlan, visibleTileChunks,
  desiredTileLod, tileIdAt, refinementCandidates, residentPointLimit, sourceForPoint, tileScopesForPoint,
  forEachCanvasSample, viewProjection, project, scopesForPoint, selectScope } = window.__haybaTest;

const order = lodOrder(512);
assert.equal(order.length, 512);
assert.equal(new Set(order).size, 512);
assert.deepEqual([...order.slice(0, 4)], [0, 256, 128, 384]);

window.haybaLoadGeometry({ generation: 1, originCm: [0, 0, 0], boundsCm: { valid: false }, coverage: { unsupportedByKind: {} }, nativeSelection: true });
function appendPage(label, x, generation = 1) {
  window.haybaAppendGeometry(generation, {
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
  window.haybaAppendSplats(generation, [[x, 0, 0, 0, 0, 1, 180, 190, 200, 0, 1, 1]]);
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
window.haybaAppendDepthSplats(0, [[150, 0, 0, 1, 0, 0, 70, 160, 190, -1, -1, -1]]);
assert.equal(state.count, 3, 'stale depth generations are ignored');
window.haybaAppendDepthSplats(1, [[150, 0, 0, 1, 0, 0, 70, 160, 190, -1, -1, -1],
  [200, 0, 0, 1, 0, 0, 90, 200, 220, 1, 2, -1],
  [300, 0, 0, 1, 0, 0, 90, 200, 220, 99, 2, -1]],
['view-a', 'view-b', 'invalid-view']);
assert.equal(state.count, 5, 'depth surfaces keep unknown labels and reject invalid references');
assert.equal(state.depthPointCount, 2, 'depth provenance stays distinct from CPU mesh sample count');
assert.ok(Math.abs(state.chunks[3].data[6] - 70 / 255) < 1e-6,
  'visible scene RGB reaches the cloud without warm palette desaturation');
assert.equal(state.chunks[3].data[9], -1, 'unknown depth source stays unknown');
assert.equal(sourceForPoint(state.chunks[3], 0).captureId, 'view-a',
  'fused depth retains its original capture provenance');
assert.equal(sourceForPoint(state.chunks[3], 1).captureId, 'view-b',
  'a second view retains distinct capture provenance');
assert.equal(state.chunks[3].data[13 + 10], 2, 'attributed depth source uses global node index');
assert.equal(state.worldBounds.max[0], 200, 'depth-only visible surfaces extend fitted bounds');
window.haybaGeometryDone(1, { partial: true, gaps: ['loaded_level_changed'], scannedActorSlots: 2, totalActorSlots: 3 });
assert.equal(state.done, true);
assert.ok(state.clusters.length > 1, 'completion creates one global spatial hierarchy');
for (const chunk of state.chunks) for (let i = 0; i < chunk.count; i++)
  assert.ok(chunk.data[i * 13 + 11] >= 0 && chunk.data[i * 13 + 11] < state.clusters.length);

// The overview leaves room around dense geometry without reducing its GPU LOD.
state.count = 131072;
state.chunks = []; state.depthPointCount = 0;
state.worldBounds = null;
state.radius = 100;
window.haybaFit();
assert.equal(state.distance, 300);
assert.equal(lodCount(512), 512);
state.distance *= 1.6;
assert.equal(lodCount(512), 256);
state.distance = 300 * 2.6;
assert.equal(lodCount(512), 128);
state.radius = 1;
window.haybaFit();
assert.equal(state.distance, 150);
assert.equal(lodCount(512), 512);
state.radius = 100;
window.haybaFit();

// Even a narrow editor dock shows every corner of a broad depth capture.
const sceneCanvas = elements.get('scene');
sceneCanvas.clientWidth = 360; sceneCanvas.clientHeight = 600;
state.worldBounds = { valid: true, min: [-500, -100, -100], max: [500, 100, 100] };
state.center = [0, 0, 0]; state.radius = Math.hypot(1000, 200, 200) / 2;
window.haybaFit();
const portraitMatrix = viewProjection(360 / 600);
for (let corner = 0; corner < 8; corner++) {
  const xyz = [0, 1, 2].map(axis => corner & (1 << axis) ? state.worldBounds.max[axis] : state.worldBounds.min[axis]);
  const pixel = project(...xyz, portraitMatrix, 360, 600);
  assert.ok(pixel && pixel.x > 15 && pixel.x < 345 && pixel.y > 25 && pixel.y < 575,
    'fitted observed bounds stay in the portrait viewport');
}

// A shallow captured World should read as a substantial silhouette at fit.
sceneCanvas.clientWidth = 1000; sceneCanvas.clientHeight = 720;
state.worldBounds = { valid: true, min: [-500, -500, 0], max: [500, 500, 0] };
state.center = [0, 0, 0]; state.radius = Math.hypot(1000, 1000) / 2;
window.haybaFit();
const landscapeMatrix = viewProjection(1000 / 720);
const corners = [
  [-500, -500, 0], [-500, 500, 0], [500, -500, 0], [500, 500, 0],
].map(xyz => project(...xyz, landscapeMatrix, 1000, 720));
const xs = corners.map(pixel => pixel.x), ys = corners.map(pixel => pixel.y);
assert.ok(Math.min(...xs) > 50 && Math.max(...xs) < 950 && Math.min(...ys) > 40 && Math.max(...ys) < 680,
  'landscape fit keeps the observed footprint inside the canvas');
assert.ok(Math.max(...xs) - Math.min(...xs) > 650,
  'the observed footprint fills enough of the landscape view to read its shape');

// Drawn positions determine fit even when source metadata understates bounds.
state.worldBounds = { valid: true, min: [-50, -50, -50], max: [50, 50, 50] };
state.center = [0, 0, 0]; state.radius = Math.hypot(100, 100, 100) / 2;
window.haybaFit();
const metadataDistance = state.distance;
let observedReads = 0;
const outsideData = new Proxy(new Float32Array(2 * 13), { get(target, key) {
  if (typeof key === 'string' && /^\d+$/.test(key)) observedReads++;
  return target[key];
} });
outsideData[0] = -500; outsideData[13] = 500;
state.chunks = [{ count: 2, data: outsideData }];
window.haybaFit();
assert.ok(state.distance > metadataDistance, 'actual drawn points can expand an understated source bound');
const firstDistance = state.distance, firstReads = observedReads;
window.haybaFit();
assert.equal(observedReads, firstReads, 'refitting an unchanged scan reuses point projection limits');
const nextData = new Float32Array(13); nextData[0] = 1000;
state.chunks.push({ count: 1, data: nextData });
window.haybaFit();
assert.ok(state.distance > firstDistance, 'a new streamed page expands the fit');
assert.equal(observedReads, firstReads, 'new pages do not rescan prior buffers');
const observedMatrix = viewProjection(1000 / 720);
for (const x of [-500, 500, 1000]) {
  const pixel = project(x, 0, 0, observedMatrix, 1000, 720);
  assert.ok(pixel && pixel.x > 95 && pixel.x < 905 && pixel.y > 65 && pixel.y < 655,
    'the drawn point remains inside the fitted viewport');
}
sceneCanvas.clientWidth = 360;
window.haybaFit();
assert.ok(observedReads > firstReads, 'portrait resize rebuilds aspect-dependent projection limits');

sceneCanvas.clientWidth = 800; sceneCanvas.clientHeight = 600;
state.chunks = [];
state.worldBounds = null; state.center = [0, 0, 0]; state.radius = 100;
window.haybaFit();
state.count = 19999;
state.distance = 10000;
assert.equal(lodCount(512), 512, 'small scans retain every point even from far away');

// Canvas distributes exactly 30,000 samples across all visible chunks.
state.count = 50000;
state.distance = 300 * 2.6;
state.chunks = [{ count: 25000 }, { count: 25000 }];
const farSamples = [];
forEachCanvasSample((chunk, index) => farSamples.push((chunk === state.chunks[0] ? 0 : 6250) + index));
assert.equal(farSamples.length, 12500, 'when LOD is below the Canvas cap, every visible point is sampled');
assert.equal(farSamples[0], 0);
assert.equal(farSamples.at(-1), 12499);

state.count = 30001;
window.haybaFit();
state.chunks = [{ count: 10000 }, { count: 20001 }];
const nearCap = [];
forEachCanvasSample((chunk, index) => nearCap.push((chunk === state.chunks[0] ? 0 : 10000) + index));
assert.equal(nearCap.length, 30000);
assert.equal(new Set(nearCap).size, 30000);
assert.equal(nearCap[0], 0);
assert.equal(nearCap.at(-1), 30000);
assert.ok(nearCap.some(index => index < 10000) && nearCap.some(index => index >= 10000));

// At fit Canvas keeps the overview budget; zooming in exposes all captured
// detail, including points from later depth pages.
state.count = state.depthPointCount = 37277;
state.chunks = [{ count: 32768, isDepth: true }, { count: 4509, isDepth: true }];
window.haybaFit();
let overviewCount = 0;
forEachCanvasSample(() => overviewCount++);
assert.equal(overviewCount, 30000);
state.distance *= .6;
let detailCount = 0, sawLaterPage = false;
forEachCanvasSample(chunk => { detailCount++; if (chunk === state.chunks[1]) sawLaterPage = true; });
assert.equal(detailCount, 37277, 'zoom reveals every captured depth point in a typical scan');
assert.equal(sawLaterPage, true);
window.haybaFit();

const chunkSize = 65536, stride = 13;
state.chunks = [0, 1].map(() => ({ count: chunkSize, data: new Float32Array(chunkSize * stride) }));
state.count = chunkSize * state.chunks.length;
assert.equal(lodCount(chunkSize), chunkSize, 'the fitted WebGL prefix retains the full bounded set');
const sampled = [];
forEachCanvasSample((chunk, index) => sampled.push((chunk === state.chunks[0] ? 0 : chunkSize) + index));
assert.equal(sampled.length, 30000);
assert.equal(new Set(sampled).size, 30000);
assert.ok(sampled[0] < 5 && sampled.at(-1) > state.count - 5, 'samples span the full scene');
assert.ok(sampled.some(index => index >= chunkSize), 'later chunks remain represented');
canvasArcCount = 0;
assert.ok(frames.length > 0);
frames.shift()();
assert.equal(canvasArcCount, 30000, 'the Canvas renderer draws its full budget at fit');

// Pick the same distributed Canvas point that was drawn, keeping its source IDs.
for (const chunk of state.chunks) for (let index = 0; index < chunk.count; index++)
  chunk.data[index * stride + 1] = 1000;
state.distance = 100;
const pickSamples = [];
forEachCanvasSample((chunk, index) => pickSamples.push((chunk === state.chunks[0] ? 0 : chunkSize) + index));
const pickSet = new Set(pickSamples);
const included = pickSamples.find((index, i) => i > 30000 && !pickSet.has(index - 1)), omitted = included - 1;
assert.ok(!pickSet.has(omitted), 'the competing closer point is outside the zoomed Canvas sample');
function pointAt(globalIndex) {
  const chunk = state.chunks[Math.floor(globalIndex / chunkSize)];
  return chunk.data.subarray((globalIndex % chunkSize) * stride, (globalIndex % chunkSize + 1) * stride);
}
const visible = pointAt(included), hidden = pointAt(omitted);
visible[1] = 0; visible[9] = 1; visible[10] = 2; visible[11] = 2;
hidden[0] = 90; hidden[1] = 0; hidden[9] = 0; hidden[10] = 1; hidden[11] = 1;
state.target = [0, 0, 0]; state.yaw = 0; state.pitch = 0;
state.drag = { moved: false, button: 0 };
elements.get('scene').listeners.pointerup({ clientX: 400, clientY: 300 });
assert.equal(state.selectedIndex, 1);
assert.equal(state.selectedNodeIndex, 2);
assert.equal(state.inspectCluster, 2);
assert.equal(window.location.href, 'hayba-scene-map://select/1/1');
console.log('splat-view progressive batches and LOD: passed');

// User-visible states follow real native payloads, not actor counts or bounds.
const message = elements.get('message');
const heading = () => message.children[0]?.textContent;
const action = () => message.children.find(child => child.listeners?.click);
window.haybaLoadGeometry({ generation: 2, originCm: [0, 0, 0], worldState: 'no_world', nativeSelection: true });
assert.equal(state.viewState, 'no_world');
assert.match(heading(), /Open a level/);
assert.equal(action().textContent, 'Open level');
action().listeners.click();
assert.equal(window.location.href, 'hayba-scene-map://open-level/2');
window.haybaGeometryDone(2, { worldState: 'no_world' });
assert.equal(state.viewState, 'no_world', 'completion preserves absent-world distinction');
window.haybaLoadGeometry({ generation: 3, originCm: [0, 0, 0], nativeSelection: true });
assert.equal(state.viewState, 'loading');
assert.equal(state.coverage.actorIteratorComplete, false, 'in-flight scans cannot claim complete coverage');
window.haybaGeometryDone(2, { worldState: 'no_world' });
assert.equal(state.viewState, 'loading', 'stale completion cannot overwrite a new scan');
window.haybaGeometryDone(3, { worldState: 'complete' });
assert.equal(state.viewState, 'empty');
assert.equal(action().textContent, 'Retry');
action().listeners.click(); assert.equal(window.location.href, 'hayba-scene-map://refresh/3');
window.haybaLoadGeometry({ generation: 4, originCm: [0, 0, 0], nativeSelection: true });
window.haybaAppendDepthSplats(4, [[0, 0, 0, 0, 0, 1, 70, 159, 190, -1, -1, -1]]);
assert.equal(message.hidden, true, 'observed geometry takes over while the scan continues');
window.haybaGeometryDone(4, { worldState: 'partial', partial: true, gaps: ['total_point_cap'] });
assert.equal(state.viewState, 'partial'); assert.equal(message.hidden, false);
assert.equal(action().textContent, 'Inspect');
action().listeners.click(); assert.equal(message.hidden, true); assert.equal(elements.get('inspect').hidden, false);
assert.equal(state.chunks[0].data[9], -1, 'unknown depth labels remain unknown in partial scans');
window.haybaLoadGeometry({ generation: 5, originCm: [0, 0, 0], nativeSelection: true });
window.haybaAppendDepthSplats(5, [[0, 0, 0, 0, 0, 1, 70, 159, 190, -1, -1, -1]]);
window.haybaGeometryDone(5, { worldState: 'complete' });
assert.equal(state.viewState, 'ready'); assert.equal(message.hidden, true);
assert.equal(timers.size, 0, 'completion cancels stall detection');
window.haybaAppendDepthSplats(5, [[100, 0, 0, 0, 0, 1, 70, 159, 190, -1, -1, -1]]);
assert.equal(state.count, 1, 'late chunks cannot mutate completed observations');
window.haybaLoadGeometry({ generation: 6, originCm: [0, 0, 0], nativeSelection: true });
[...timers.values()][0](); assert.equal(state.viewState, 'failed');
assert.equal(action().textContent, 'Retry');
window.haybaAppendDepthSplats(6, [[0, 0, 0, 0, 0, 1, 70, 159, 190, -1, -1, -1]]);
assert.equal(state.viewState, 'loading', 'late valid depth progress clears the timeout notice');
assert.equal(message.hidden, true);
window.haybaGeometryDone(6, { worldState: 'failed', gaps: ['editor_world_changed'] });
assert.equal(state.viewState, 'failed'); assert.equal(state.count, 0);
assert.equal(state.actors.length, 0, 'a changed world cannot retain select-able old observations');
window.haybaLoadGeometry({ generation: 7, originCm: [0, 0, 0] });
window.haybaGeometryDone(7, { worldState: 'partial', partial: true });
assert.equal(state.viewState, 'partial'); assert.equal(action().textContent, 'Retry');
window.haybaLoadGeometry({ generation: 6, originCm: [0, 0, 0] });
assert.equal(state.generation, 7, 'stale loads cannot replace a current scan');
window.haybaLoadGeometry({ generation: 8, originCm: [0, 0, 0], nativeSelection: true });
appendPage('old-source', 0, 8);
assert.equal(state.actors.length, 1);
assert.equal(state.count, 1);
window.haybaLoadGeometry({ generation: 9, originCm: [NaN, 0, 0] });
assert.equal(state.viewState, 'failed', 'invalid initial payload is a recoverable failure');
assert.equal(state.generation, null, 'malformed next generation cannot leave old selection IDs valid');
assert.equal(state.actors.length, 0);
assert.equal(state.count, 0);
action().listeners.click(); assert.equal(reloads, 1, 'retry reloads the page when native generation is unknown');
window.haybaLoadGeometry({ generation: 10, originCm: [0, 0, 0], nativeSelection: true });
[...timers.values()][0](); assert.equal(state.viewState, 'failed');
appendPage('resumed', 0, 10);
assert.equal(state.viewState, 'loading', 'metadata-only progress clears a timeout notice');
assert.equal(message.hidden, true);
elements.get('scene').listeners.webglcontextlost({ preventDefault() {} });
assert.match(heading(), /unavailable/); assert.equal(action().textContent, 'Retry');
console.log('splat-view World loading, coverage, recovery, and stale transitions: passed');

// A mostly unlabeled depth overlay must not steal a click from a known actor.
window.haybaLoadGeometry({ generation: 11, originCm: [0, 0, 0], nativeSelection: true });
appendPage('known', 0, 11);
const oldData = state.chunks[0].data;
let oldHighlightWrites = 0;
state.chunks[0].data = new Proxy(oldData, { set(target, key, value) {
  oldHighlightWrites++; target[key] = value; return true;
} });
window.haybaAppendDepthSplats(11, [[1, 0, 0, 1, 0, 0, 145, 138, 129, -1, -1, -1]]);
state.chunks[0].data = oldData;
assert.equal(oldHighlightWrites, 0, 'streaming a depth page does not reprocess older GPU chunks');
window.haybaGeometryDone(11, { worldState: 'complete' });
state.target = [0, 0, 0]; state.yaw = 0; state.pitch = 0; state.distance = 100;
state.drag = { moved: false, button: 0 };
elements.get('scene').listeners.pointerup({ clientX: 400, clientY: 300 });
assert.equal(state.selectedIndex, 0, 'nearby known actor wins over unlabeled samples of the same surface');
assert.equal(window.location.href, 'hayba-scene-map://select/11/0');

window.haybaLoadGeometry({ generation: 12, originCm: [0, 0, 0], nativeSelection: true });
window.haybaAppendDepthSplats(12, [[0, 0, 0, 1, 0, 0, 145, 138, 129, -1, -1, -1]]);
window.haybaGeometryDone(12, { worldState: 'complete' });
state.target = [0, 0, 0]; state.yaw = 0; state.pitch = 0; state.distance = 100;
state.drag = { moved: false, button: 0 };
elements.get('scene').listeners.pointerup({ clientX: 400, clientY: 300 });
assert.equal(state.selectedIndex, -1, 'unattributed depth never fabricates an actor selection');
assert.equal(state.inspectMode, 'spatial', 'unattributed depth can still open its spatial group');

window.haybaLoadGeometry({ generation: 13, originCm: [0, 0, 0], nativeSelection: true });
appendPage('behind-surface', 0, 13);
window.haybaAppendDepthSplats(13, [[90, 0, 0, 1, 0, 0, 145, 138, 129, -1, -1, -1]]);
window.haybaGeometryDone(13, { worldState: 'complete' });
state.target = [0, 0, 0]; state.yaw = 0; state.pitch = 0; state.distance = 100;
state.drag = { moved: false, button: 0 };
elements.get('scene').listeners.pointerup({ clientX: 400, clientY: 300 });
assert.equal(state.selectedIndex, -1, 'a foreground unknown surface does not select an occluded actor');
assert.equal(state.inspectMode, 'spatial');

// Native rows are already coarse-to-fine across the raster. Preserve their
// order inside each page, then thin the global prefix so all quadrants survive.
window.haybaLoadGeometry({ generation: 14, originCm: [0, 0, 0] });
const depthRows = Array.from({ length: 512 }, (_, ordinal) => [ordinal, 0, 0, 1, 0, 0, 145, 138, 129, -1, -1, -1]);
window.haybaAppendDepthSplats(14, depthRows);
assert.deepEqual(Array.from(state.chunks[0].data.slice(0, 13 * 4).filter((_, i) => i % 13 === 0)), [0, 1, 2, 3],
  'depth rows retain native coarse-to-fine ordering');
state.chunks = []; state.worldBounds = null; state.radius = 100;
window.haybaFit();
state.chunks = Array.from({ length: 128 }, () => ({ count: 512, isDepth: true }));
state.count = state.depthPointCount = 65536;
state.distance = 300 * 2.6;
const farDepth = visibleChunkCounts();
assert.equal(farDepth.reduce((sum, count) => sum + count, 0), 16384);
assert.ok(farDepth.slice(0, 32).every(count => count === 512));
assert.ok(farDepth.slice(32).every(count => count === 0));
function pixelAtOrdinal(ordinal) {
  let x = 0, y = 0;
  for (let bit = 0; bit < 8; bit++) {
    x |= ((ordinal >> (2 * bit)) & 1) << (7 - bit);
    y |= ((ordinal >> (2 * bit + 1)) & 1) << (7 - bit);
  }
  return [x, y];
}
const quadrants = new Set();
for (let ordinal = 0; ordinal < 16384; ordinal++) {
  const [x, y] = pixelAtOrdinal(ordinal);
  quadrants.add(`${x >= 128},${y >= 128}`);
}
assert.equal(quadrants.size, 4, 'far depth LOD keeps all four view quadrants');
console.log('splat-view dense depth selection, streaming, and spatial LOD: passed');

// The default fit favors the observed mass while Fit all preserves access to
// distant depth points and never removes them from the scene data.
window.haybaLoadGeometry({ generation: 15, originCm: [0, 0, 0], nativeSelection: true });
const focusRows = Array.from({ length: 1024 }, (_, i) =>
  [((i % 32) - 16) * 20, (Math.floor(i / 32) - 16) * 20, 0, 0, 0, 1, 145, 138, 129, -1, -1, -1]);
focusRows.push([50000, 0, 0, 0, 0, 1, 145, 138, 129, -1, -1, -1]);
window.haybaAppendDepthSplats(15, focusRows);
const streamedAllDistance = state.distance;
window.haybaGeometryDone(15, { worldState: 'complete' });
assert.equal(state.count, 1025, 'the distant observation remains loaded');
assert.ok(state.focusFit.coreBoundsCm.max[0] < 50000, 'spatial LOD uses the main observed mass');
const denseCells = new Set(Array.from({ length: 1024 }, (_, i) => state.chunks[0].data[i * 13 + 11]));
assert.ok(denseCells.size > 8, 'a distant sample cannot collapse nearby surfaces into one spatial cell');
const distantCluster = state.chunks[0].data[1024 * 13 + 11];
assert.equal(state.clusters[distantCluster].kind, 'outside_core',
  'the far observation remains selectable as an explicit exterior group');
assert.equal(state.fitMode, 'focus');
assert.ok(state.distance < streamedAllDistance / 3, 'completed scan frames its dense central mass');
const focusDistance = state.distance;
const focusMatrix = viewProjection(800 / 600);
const coreWithinMargin = focusRows.slice(0, -1).filter(row => {
  const pixel = project(row[0], row[1], row[2], focusMatrix, 800, 600);
  return pixel && pixel.x >= 80 && pixel.x <= 720 && pixel.y >= 60 && pixel.y <= 540;
}).length;
assert.ok(coreWithinMargin >= 1024 * .9, 'the dense scene keeps a ten-percent viewport margin');
window.haybaFitAll();
assert.equal(state.fitMode, 'all');
assert.ok(state.distance > focusDistance * 3);
const farPixel = project(50000, 0, 0, viewProjection(800 / 600), 800, 600);
assert.ok(farPixel && farPixel.x > 0 && farPixel.x < 800 && farPixel.y > 0 && farPixel.y < 600,
  'Fit all includes the distant observed point');
elements.get('fit').listeners.click({ shiftKey: false });
assert.equal(state.fitMode, 'focus');
elements.get('fit').listeners.click({ shiftKey: true });
assert.equal(state.fitMode, 'all', 'Shift-click exposes Fit all');
elements.get('scene').listeners.keydown({ key: 'f', shiftKey: false, preventDefault() {} });
assert.equal(state.fitMode, 'focus');
elements.get('scene').listeners.keydown({ key: 'F', shiftKey: true, preventDefault() {} });
assert.equal(state.fitMode, 'all', 'Shift+F exposes Fit all from the keyboard');
console.log('splat-view dominant-mass framing and explicit Fit all: passed');

// One observation can belong to authored, asset, tag, and spatial groups.
// Cycling the selected group changes the highlighted points without stealing
// the ordinary wheel gesture used to navigate the dense point cloud.
window.haybaLoadGeometry({ generation: 16, originCm: [0, 0, 0], nativeSelection: true });
window.haybaAppendGeometry(16, {
  actors: [{ label: 'Stall A' }, { label: 'Stall B' }, { label: 'Tree' }],
  nodes: [
    { kind: 'world', parentIndex: -1 },
    { kind: 'actor', label: 'Stall A', parentIndex: 0, actorIndex: 0, tags: ['market'] },
    { kind: 'static_mesh_component', label: 'Awning A', parentIndex: 1, actorIndex: 0, meshAsset: '/Game/Props/Stall' },
    { kind: 'actor', label: 'Stall B', parentIndex: 0, actorIndex: 1, tags: ['market'] },
    { kind: 'static_mesh_component', label: 'Awning B', parentIndex: 3, actorIndex: 1, meshAsset: '/Game/Props/Stall' },
    { kind: 'actor', label: 'Tree', parentIndex: 0, actorIndex: 2, tags: ['forest'] },
    { kind: 'static_mesh_component', label: 'Trunk', parentIndex: 5, actorIndex: 2, meshAsset: '/Game/Props/Tree' },
  ],
  clusters: [{ level: 0, parentIndex: -1 }],
  boundsCm: { valid: true, min: [0, 0, 0], max: [0, 200, 0] },
  coverage: { actorCount: 3, stopReasons: [], unsupportedByKind: {} },
});
window.haybaAppendSplats(16, [
  [0, 0, 0, 0, 0, 1, 180, 180, 180, 0, 2, -1],
  [0, 10, 0, 0, 0, 1, 180, 180, 180, 0, 2, -1],
  [0, 100, 0, 0, 0, 1, 180, 180, 180, 1, 4, -1],
  [0, 200, 0, 0, 0, 1, 180, 180, 180, 2, 6, -1],
]);
window.haybaGeometryDone(16, { worldState: 'complete' });
const point = state.chunks[0].data;
const scopes = scopesForPoint({ actorIndex: point[9], nodeIndex: point[10], clusterIndex: point[11], isDepth: false });
const keys = scopes.map(scope => scope.key);
assert.ok(keys.includes('node:1') && keys.includes('node:2'), 'authored actor and component both remain selectable');
assert.ok(keys.includes('tag:market') && keys.includes('asset:/Game/Props/Stall'),
  'author tags and shared mesh assets become distinct cross-actor cohorts');
assert.ok(keys.some(key => key.startsWith('cluster:')), 'position-derived groups are available alongside authored groups');
state.selectionScopes = scopes;
selectScope(keys.indexOf('tag:market'));
assert.deepEqual(Array.from({ length: 4 }, (_, i) => point[i * 13 + 12]), [1, 1, 1, 0],
  'tag highlighting includes both stalls and excludes the untagged tree');
selectScope(keys.indexOf('asset:/Game/Props/Stall'));
assert.deepEqual(Array.from({ length: 4 }, (_, i) => point[i * 13 + 12]), [1, 1, 1, 0],
  'shared asset highlighting spans two actors');
selectScope(keys.indexOf('node:2'));
assert.deepEqual(Array.from({ length: 4 }, (_, i) => point[i * 13 + 12]), [1, 0, 1, 0],
  'component highlighting stays inside its authored source');
assert.equal(elements.get('scope').hidden, false);
const beforeZoom = state.distance, beforeScope = state.scopeIndex;
elements.get('scene').listeners.wheel({ deltaY: 100, altKey: false, preventDefault() {} });
assert.ok(state.distance > beforeZoom, 'ordinary wheel still zooms');
assert.equal(state.scopeIndex, beforeScope);
const afterZoom = state.distance;
elements.get('scene').listeners.wheel({ deltaY: 100, altKey: true, preventDefault() {} });
assert.equal(state.distance, afterZoom, 'Alt-wheel changes the group without zooming');
assert.equal(state.scopeIndex, (beforeScope + 1) % scopes.length);
elements.get('scope').listeners.wheel({ deltaY: -100, preventDefault() {} });
assert.equal(state.scopeIndex, beforeScope, 'wheel over the scope rail moves through groups');
elements.get('scope-next').listeners.click();
elements.get('scope-prev').listeners.click();
assert.equal(state.scopeIndex, beforeScope, 'compact buttons offer an accessible alternative');
const unknownScopes = scopesForPoint({ actorIndex: -1, nodeIndex: -1, clusterIndex: point[11], isDepth: true });
assert.ok(unknownScopes.length > 0 && unknownScopes.every(scope => scope.type === 'clusters'),
  'unattributed depth can join spatial groups but never acquires invented authored semantics');
window.haybaReset();
assert.equal(elements.get('scope').hidden, true, 'reset removes stale group controls');
console.log('splat-view overlapping semantic scopes and selection controls: passed');

// Refined CPU-mesh tiles are real, independently addressable point arrays. A
// local zoom exposes the focal tile while far tiles stay out of the draw plan.
window.haybaLoadGeometry({ generation: 17, originCm: [0, 0, 0], nativeSelection: true });
window.haybaAppendGeometry(17, {
  actors: [{ label: 'Reference stall', path: '/Game/World/ReferenceStall' }],
  nodes: [
    { id: 'world', kind: 'world', parentIndex: -1 },
    { id: 'actor:reference', kind: 'actor', label: 'Reference stall', parentIndex: 0, actorIndex: 0,
      tags: ['market'] },
    { id: 'mesh:reference', kind: 'static_mesh_component', label: 'Canopy', parentIndex: 1,
      actorIndex: 0, meshAsset: '/Game/Props/Stall' },
  ],
  clusters: [{ level: 0, parentIndex: -1 }],
  boundsCm: { valid: true, min: [0, 0, 0], max: [1000, 1000, 1000] },
  coverage: { actorCount: 1, stopReasons: [], unsupportedByKind: {} },
});
window.haybaAppendSplats(17, Array.from({ length: 64 }, (_, i) =>
  [(i % 8) * 125, Math.floor(i / 8) * 125, 250, 0, 0, 1, 180, 170, 150, 0, 2, -1]));
window.haybaGeometryDone(17, { worldState: 'complete' });
const tileRowsByPage = Array.from({ length: 8 }, (_, pageId) => Array.from({ length: 1024 }, (_, i) =>
  [(i % 32) * 30, Math.floor(i / 32) * 30, pageId * 100 + i % 7, 0, 0, 1,
    180, 170, 150, 0, 2, -1]));
function fillTile(x, y, z = 0) {
  const tileId = `tile:2:${x}:${y}:${z}`, originCm = [x * 1000, y * 1000, z * 1000];
  const boundsCm = { valid: true, min: originCm, max: originCm.map(value => value + 1000) };
  window.haybaTileBegin(17, { tileId, lod: 2, boundsCm, originCm });
  for (let pageId = 0; pageId < 8; pageId++) {
    const actorPath = `/Game/World/Tile_${x}_${y}_${z}`;
    window.haybaTileAppend(17, tileId, { pageId, chunkIndex: 0, originCm,
      actors: [{ label: 'Market stall', path: actorPath }],
      nodes: [
        { id: 'world', kind: 'world', parentIndex: -1 },
        { id: `actor:${x}:${y}:${z}`, kind: 'actor', label: 'Market stall', parentIndex: 0,
          actorIndex: 0, tags: ['market'] },
        { id: `mesh:${x}:${y}:${z}`, kind: 'static_mesh_component', label: 'Canopy', parentIndex: 1,
          actorIndex: 0, meshAsset: '/Game/Props/Stall' },
      ], splats: tileRowsByPage[pageId] });
  }
  window.haybaTileDone(17, { tileId, pointCount: 8192, partial: false, gaps: [] });
  return tileId;
}
const focalId = fillTile(0, 0), distantId = fillTile(0, 50);
assert.equal(state.tilePointCount, 16384);
assert.equal(state.depthPointCount, 0, 'CPU mesh refinement is never relabeled as view depth');
const focalChunk = state.tiles.get(focalId).chunks[0];
const source = sourceForPoint(focalChunk, 0);
assert.equal(source.provenance, 'cpu_render_lod');
assert.equal(source.node.id, 'mesh:0:0:0');
assert.equal(source.actor.path, '/Game/World/Tile_0_0_0');
assert.equal(source.tileId, focalId);
assert.equal(source.pageId, 0);
assert.ok(focalChunk.data[6] > focalChunk.data[8], 'source color is harmonized to the warm palette');
const tileScopes = tileScopesForPoint({ chunk: focalChunk, index: 0 });
assert.ok(tileScopes.some(scope => scope.key === 'tag:market'));
assert.ok(tileScopes.some(scope => scope.key === 'asset:/Game/Props/Stall'));
const distantScopes = tileScopesForPoint({ chunk: state.tiles.get(distantId).chunks[0], index: 0 });
assert.ok(distantScopes.some(scope => scope.key === `region:${distantId}`),
  'a refined tile outside the overview still has a selectable spatial hierarchy');
state.selectionScopes = tileScopes;
selectScope(tileScopes.findIndex(scope => scope.key === 'tag:market'));
assert.equal(focalChunk.data[12], 1);
assert.equal(state.tiles.get(distantId).chunks[0].data[12], 1,
  'one authored tag highlights matching source points across cached tiles');
window.haybaReset();
state.userMoved = true; state.target = [500, 500, 500]; state.distance = 1500;
assert.equal(desiredTileLod(), 2);
assert.equal(tileIdAt(2, [500, 500, 500]), focalId);
const nearbyCandidates = refinementCandidates(800, 600);
assert.equal(nearbyCandidates[0], focalId, 'the focal tile is requested first');
assert.ok(nearbyCandidates.length > 7 && nearbyCandidates.length <= 27,
  'local zoom requests a bounded, view-visible neighborhood beyond the former seven-tile cross');
assert.equal(new Set(nearbyCandidates).size, nearbyCandidates.length);
assert.ok(nearbyCandidates.every(id => /^tile:2:-?\d+:-?\d+:-?\d+$/.test(id)));
const focalPlan = visibleRenderPlan(800, 600);
assert.equal(focalPlan.filter(item => item.chunk.tile?.id === focalId).reduce((sum, item) => sum + item.count, 0), 8192);
assert.equal(focalPlan.some(item => item.chunk.tile?.id === distantId), false,
  'a far tile does not consume a focused frame budget');
assert.ok(focalPlan.reduce((sum, item) => sum + item.count, 0) <= 180000);
state.target = [500, 50500, 500];
assert.ok(visibleTileChunks(800, 600).some(chunk => chunk.tile.id === distantId));
assert.equal(visibleTileChunks(800, 600).some(chunk => chunk.tile.id === focalId), false);
state.distance = 13000;
assert.equal(desiredTileLod(), -1);
assert.equal(refinementCandidates(800, 600).length, 0, 'overview does not queue refinement');
assert.equal(visibleTileChunks(800, 600).length, 0, 'overview drops high-detail tile draw calls');
state.distance = 4000;
assert.equal(desiredTileLod(), 1);
assert.ok(refinementCandidates(800, 600).length <= 11,
  'broader zoom uses a smaller view-prioritized tile neighborhood');
console.log('splat-view focused tile LOD, semantics, and source provenance: passed');

// This feeds 256 distinct 8,192-point tiles through the same callback path as
// native refinement. The addressable CPU cache reaches 2,097,152 actual points;
// it never allocates two million JS objects or draws all of them in a frame.
const memoryBefore = process.memoryUsage(), startedAt = Date.now();
for (let index = 1; index < 255; index++) fillTile(index % 16, Math.floor(index / 16));
const elapsedMs = Date.now() - startedAt, memoryAfter = process.memoryUsage();
assert.equal(state.tilePointCount, 256 * 8192);
assert.equal(state.tiles.size, 256);
assert.equal(state.tileChunks.length, 256 * 8);
assert.equal(residentPointLimit(), 256 * 8192);
state.target = [500, 500, 500]; state.distance = 1500;
const densePlan = visibleRenderPlan(800, 600);
const denseVisible = visibleTileChunks(800, 600);
assert.ok(denseVisible.length > 11, 'stress view contains more tiles than the full-detail draw budget');
for (const chunk of denseVisible)
  assert.ok(densePlan.some(item => item.chunk === chunk && item.count > 0),
    'fair point LOD keeps every visible refined tile represented');
assert.ok(densePlan.reduce((sum, item) => sum + item.count, 0) <= 180000,
  'two million resident points still obey the GPU draw ceiling');
assert.ok(densePlan.some(item => item.chunk.tile?.id === focalId));
assert.equal(densePlan.some(item => item.chunk.tile?.id === distantId), false);
console.log(`splat-view 2,097,152 resident points: ${elapsedMs} ms ingest; ` +
  `${Math.round((memoryAfter.arrayBuffers - memoryBefore.arrayBuffers) / 1048576)} MiB ArrayBuffer delta; ` +
  `${Math.round((memoryAfter.rss - memoryBefore.rss) / 1048576)} MiB RSS delta; ` +
  `${densePlan.reduce((sum, item) => sum + item.count, 0)} drawn points across ${denseVisible.length} visible tiles`);
fillTile(16, 0);
assert.equal(state.tilePointCount, 256 * 8192, 'an additional tile evicts before raising resident memory');
assert.equal(state.tiles.size, 256);
assert.equal(state.tiles.has(focalId), false, 'least-recent tile was evicted');
window.navigator = { deviceMemory: 2 };
fillTile(17, 0);
assert.ok(state.tilePointCount <= 512 * 1024 && state.tiles.size <= 64,
  'low-memory devices trim the resident cache while retaining focused rendering');
console.log('splat-view 2M cache ceiling, draw ceiling, and low-memory eviction: passed');

// A depth-only click while the scan is still streaming retains its exact
// source point until spatial groups have been built at completion.
window.haybaLoadGeometry({ generation: 18, originCm: [0, 0, 0], nativeSelection: true });
window.haybaAppendDepthSplats(18, [[0, 0, 0, 0, 0, 1, 120, 145, 170, -1, -1, -1]]);
state.target = [0, 0, 0]; state.yaw = 0; state.pitch = 0; state.distance = 100;
state.drag = { moved: false, button: 0 };
elements.get('scene').listeners.pointerup({ clientX: 400, clientY: 300 });
assert.ok(state.pointSelection, 'the unattributed observed point remains selected before hierarchy completion');
assert.equal(state.selectionEvidence.provenance, 'view_depth');
assert.equal(window.haybaGetSelectedWorldEvidence().provenance, 'view_depth',
  'Chat grounding can read the selected source provenance without guessing');
assert.equal(state.selectionScopes.length, 0);
window.haybaGeometryDone(18, { worldState: 'complete' });
assert.ok(state.selectionScopes.some(scope => scope.key.startsWith('cluster:')),
  'the same point gains derived spatial groups when the scan finishes');
console.log('splat-view streaming depth selection provenance: passed');

// Native keeps more observed voxels than the overview can ship. A focused
// region asks for an absolute-world tile, then streams its own bounded depth
// cache without assigning identity to unmatched raster pixels.
state.completion.observationFusion = { residentPointCount: 200000, displayedPointCount: 100000 };
state.userMoved = true; state.distance = 1200; state.target = [0, 0, 0];
elements.get('scene').listeners.wheel({ deltaY: 1, preventDefault() {} });
for (const [id, callback] of [...timers]) if (timers.has(id)) { timers.delete(id); callback(); }
assert.match(window.location.href, /^hayba-scene-map:\/\/refine-observed\/18\/2\//,
  'zoom requests regional observations in the current native generation');
const observedId = state.observedInFlight;
assert.ok(observedId);
const observedRow = [20, 0, 0, 0, 0, 1, 30, 90, 180, -1, -1, -1];
window.haybaAppendObservedTile(17, observedId, [observedRow], ['old'], true);
assert.equal(state.observedTiles.size, 0, 'stale generations cannot add regional points');
window.haybaAppendObservedTile(18, observedId, [observedRow], ['view-a'], false);
window.haybaAppendObservedTile(18, observedId, [[40, 0, 0, 0, 0, 1, 40, 100, 200, -1, -1, -1]], ['view-b'], true);
const observed = state.observedTiles.get(observedId).chunk;
assert.equal(observed.count, 2);
assert.equal(sourceForPoint(observed, 0).captureId, 'view-a');
assert.equal(sourceForPoint(observed, 1).captureId, 'view-b');
assert.equal(sourceForPoint(observed, 0).actor, undefined, 'unknown pixels stay unattributed');
assert.equal(sourceForPoint(observed, 0).tileId, observedId);
assert.ok(visibleRenderPlan(800, 600).some(item => item.chunk === observed),
  'focused renderer can reach observed points beyond overview limit');
window.haybaInvalidateWorld(19, 'pie');
assert.equal(state.observedTiles.size, 0);
assert.equal(state.chunks.length, 0);
assert.equal(state.pointSelection, null);
assert.equal(window.haybaGetSelectedWorldEvidence(), null, 'PIE removes pickable stale evidence');
window.haybaAppendObservedTile(18, observedId, [observedRow], ['late'], true);
assert.equal(state.observedTiles.size, 0, 'late native chunks are rejected after PIE');
console.log('splat-view regional observed LOD and PIE invalidation: passed');

window.haybaLoadGeometry({ generation: 20, originCm: [0, 0, 0], nativeSelection: true });
window.haybaAppendDepthSplats(20, [observedRow], ['overview-first']);
state.userMoved = true; state.distance = 1200; state.target = [0, 0, 0];
window.haybaFusionReady(20, 200000, 163840);
assert.equal(state.done, false, 'overview completion still waits for the remaining streamed points');
const earlyRefineTimer = Math.max(...timers.keys());
const earlyRefine = timers.get(earlyRefineTimer);
timers.delete(earlyRefineTimer); earlyRefine();
assert.match(window.location.href, /^hayba-scene-map:\/\/refine-observed\/20\/2\//,
  'regional detail can start after the first overview batch, before full replay');
assert.equal(state.refineInFlight, null, 'CPU mesh refinement still waits for completed geometry');
console.log('splat-view early regional detail during bounded overview replay: passed');

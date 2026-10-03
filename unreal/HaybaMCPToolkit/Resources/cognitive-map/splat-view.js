(function () {
  'use strict';
  const canvas = document.getElementById('scene');
  const message = document.getElementById('message');
  const selectedLabel = document.getElementById('selected');
  const scopeRail = document.getElementById('scope');
  const scopeCopy = document.getElementById('scope-copy');
  const exploreButton = document.getElementById('explore');
  const inspect = document.getElementById('inspect');
  const inspectTitle = document.getElementById('inspect-title');
  const inspectSubtitle = document.getElementById('inspect-subtitle');
  const inspectTrail = document.getElementById('inspect-trail');
  const inspectBody = document.getElementById('inspect-body');
  const spatialTab = document.getElementById('spatial-tab');
  const authoredTab = document.getElementById('authored-tab');
  // The wire row has 12 fields. The renderer adds one mutable highlight flag
  // so parent hierarchy selections can tint all descendant source splats.
  const ROW_FIELDS = 12, STRIDE = 13, ACTOR = 9, NODE = 10, CLUSTER = 11, HIGHLIGHT = 12;
  // The overview is deliberately bounded. Refined CPU-mesh tiles are fetched
  // on demand and held in a separate, small resident cache.
  const MAX_POINTS = 163840;
  const MAX_RESIDENT_TILES = 256;
  const MAX_TILE_POINTS = 8192;
  const MAX_RESIDENT_TILE_POINTS = MAX_RESIDENT_TILES * MAX_TILE_POINTS;
  const MAX_GPU_DRAW_POINTS = 180000;
  const MAX_BASE_DRAW_POINTS_WITH_TILES = 90000;
  const MAX_SELECTED_DRAW_POINTS = 50000;
  const DEPTH_CHUNK_POINTS = 8192;
  const OVERVIEW_CANVAS_POINTS = 30000;
  const DETAIL_CANVAS_POINTS = 60000;
  let gl = null;
  try { gl = canvas.getContext('webgl', { antialias: false, alpha: false }); } catch { /* CEF can disable WebGL. */ }
  let ctx = null;
  if (!gl) try { ctx = canvas.getContext('2d'); } catch { /* Show explicit unavailable state below. */ }
  const state = { generation: null, coverage: null, actors: [], nodes: [], clusters: [], chunks: [], tiles: new Map(),
    tileChunks: [], tilePointCount: 0, refineQueue: [], refineInFlight: null,
    pendingTileSelect: null, count: 0, depthPointCount: 0, done: false, nativeSelection: false,
    pending: null, completion: null, worldState: 'loading', viewState: 'loading', noticeDismissed: false,
    originCm: [0, 0, 0], inspectMode: 'spatial', inspectNode: -1, inspectCluster: -1,
    center: [0, 0, 0], radius: 100, target: [0, 0, 0], yaw: -.75, pitch: .36, distance: 300, fittedDistance: 300,
    focusFit: null, fitMode: 'focus',
    drag: null, userMoved: false, selectedIndex: -1, selectedNodeIndex: -1, highlightedNodeIndex: -1, selectedClusterIndex: -1,
    pointSelection: null, selectionScopes: [], selectionEvidence: null, scopeIndex: 0 };
  let program, attributes, uniforms, framePending = false, refineTimer = null, refineTimeout = null;

  let stallTimer = null, rendererFailed = false;
  function retryScan() {
    if (state.nativeSelection && state.generation !== null)
      window.location.href = `hayba-scene-map://refresh/${state.generation}`;
    else window.location.reload();
  }
  function showMessage(title, detail, action, callback, compact = false) {
    message.replaceChildren();
    message.classList.toggle('compact', compact);
    const heading = document.createElement('strong'); heading.textContent = title;
    message.append(heading, document.createTextNode(detail || ''));
    if (action) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = action;
      button.addEventListener('click', callback); message.append(button);
    }
    message.hidden = false;
  }
  function hideMessage() { message.hidden = true; }
  function updateViewState() {
    if (rendererFailed) {
      state.viewState = 'failed';
      showMessage('World preview unavailable', 'The browser could not draw this preview.', 'Retry', () => window.location.reload());
    } else if (state.worldState === 'no_world') {
      state.viewState = 'no_world';
      showMessage('Open a level to explore World', 'No editor world is available. Choose a level in Unreal to begin.',
        state.nativeSelection ? 'Open level' : null,
        () => { window.location.href = `hayba-scene-map://open-level/${state.generation}`; });
    } else if (state.worldState === 'failed') {
      state.viewState = 'failed';
      showMessage('World scan interrupted', state.count ? 'The visible samples are incomplete. Retry to update this view.' :
        'The scan could not finish. Retry to inspect the current loaded world.', 'Retry', retryScan, state.count > 0);
    } else if (!state.done) {
      state.viewState = 'loading';
      if (state.count) hideMessage();
      else showMessage('Reading loaded World…', 'Observed surfaces will appear as the scan arrives.');
    } else if (!state.count) {
      state.viewState = state.worldState === 'partial' ? 'partial' : 'empty';
      showMessage(state.viewState === 'partial' ? 'Scan incomplete' : 'No observed surfaces to show',
        state.viewState === 'partial' ? 'The scan stopped before it found renderable surfaces. Retry to scan the loaded level.' :
          'This scan produced no points. Loaded content may be outside the sampled view or use unsupported geometry.', 'Retry', retryScan);
    } else if (state.worldState === 'partial') {
      state.viewState = 'partial';
      if (state.noticeDismissed) hideMessage();
      else showMessage('Some loaded sources were not sampled', 'Explore the available surfaces and scan gaps.', 'Inspect', () => {
        state.noticeDismissed = true; hideMessage(); openInspector();
      }, true);
    } else { state.viewState = 'ready'; hideMessage(); }
  }
  function releaseChunk(chunk) {
    if (gl && chunk.buffer) gl.deleteBuffer(chunk.buffer);
    if (gl && chunk.selectedBuffer) gl.deleteBuffer(chunk.selectedBuffer);
  }
  function clearTiles() {
    window.clearTimeout(refineTimer); window.clearTimeout(refineTimeout);
    refineTimer = refineTimeout = null;
    for (const chunk of state.tileChunks) releaseChunk(chunk);
    for (const tile of state.tiles.values()) releaseChunk(tile.renderChunk);
    state.tiles.clear(); state.tileChunks = []; state.tilePointCount = 0;
    state.refineQueue = []; state.refineInFlight = null;
    state.pendingTileSelect = null;
    state.selectionEvidence = null;
  }
  function residentPointLimit() {
    let limit = MAX_RESIDENT_TILE_POINTS;
    const deviceGiB = window.navigator?.deviceMemory;
    if (Number.isFinite(deviceGiB)) {
      if (deviceGiB < 4) limit = Math.min(limit, 512 * 1024);
      else if (deviceGiB < 8) limit = Math.min(limit, 1024 * 1024);
    }
    const memory = window.performance?.memory;
    if (memory && Number.isFinite(memory.jsHeapSizeLimit) && memory.jsHeapSizeLimit > 0 &&
      Number.isFinite(memory.usedJSHeapSize)) {
      const headroom = memory.jsHeapSizeLimit - memory.usedJSHeapSize;
      if (headroom < 128 * 1024 * 1024) limit = Math.min(limit, 256 * 1024);
      else if (headroom < 256 * 1024 * 1024) limit = Math.min(limit, 512 * 1024);
    }
    return Math.max(MAX_TILE_POINTS, limit);
  }
  function evictOldestTile() {
    while (state.tiles.size >= MAX_RESIDENT_TILES ||
      state.tilePointCount + MAX_TILE_POINTS > residentPointLimit()) {
      const tile = state.tiles.values().next().value;
      if (!tile) return;
      releaseChunk(tile.renderChunk);
      for (const chunk of tile.chunks) {
        releaseChunk(chunk);
        const index = state.tileChunks.indexOf(chunk);
        if (index >= 0) state.tileChunks.splice(index, 1);
        state.tilePointCount -= chunk.count;
        if (state.pointSelection?.chunk === chunk || state.pointSelection?.chunk === tile.renderChunk) clearScopes();
      }
      state.tiles.delete(tile.id);
    }
  }
  function awaitScanProgress() {
    window.clearTimeout(stallTimer);
    if (state.done || state.worldState === 'no_world') return;
    stallTimer = window.setTimeout(() => {
      if (document.hidden) { awaitScanProgress(); return; }
      state.worldState = 'failed'; updateViewState();
    }, 30000);
  }
  function finite3(v) { return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite); }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function unit(a) { const l = Math.hypot(...a) || 1; return a.map(x => x / l); }
  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
  function warmColor(row, isDepth) {
    const source = [6, 7, 8].map(field => clamp(row[field] / 255, 0, 1));
    const luminance = source[0] * .25 + source[1] * .62 + source[2] * .13;
    const neutral = [clamp(luminance * 1.12 + .04, 0, 1), clamp(luminance * 1.01, 0, 1),
      clamp(luminance * .89, 0, 1)];
    const blend = isDepth ? .52 : .34;
    return source.map((value, channel) => value * (1 - blend) + neutral[channel] * blend);
  }
  function camera() {
    const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
    const eye = [state.target[0] + state.distance * cp * Math.cos(state.yaw), state.target[1] + state.distance * cp * Math.sin(state.yaw), state.target[2] + state.distance * sp];
    const forward = unit(sub(state.target, eye));
    const right = unit(cross(forward, [0, 0, 1]));
    return { eye, forward, right, up: cross(right, forward) };
  }
  function defaultFitBasis() {
    const yaw = -.75, pitch = .36, cp = Math.cos(pitch);
    const forward = [-cp * Math.cos(yaw), -cp * Math.sin(yaw), -Math.sin(pitch)];
    const right = unit(cross(forward, [0, 0, 1]));
    return { forward, right, up: cross(right, forward) };
  }
  function viewProjection(aspect) {
    const c = camera(), near = Math.max(.1, state.distance / 10000), far = Math.max(10000, state.distance + state.radius * 10);
    const f = 1 / Math.tan(Math.PI / 6), nf = 1 / (near - far);
    const v = [c.right[0], c.up[0], -c.forward[0], 0,
      c.right[1], c.up[1], -c.forward[1], 0,
      c.right[2], c.up[2], -c.forward[2], 0,
      -dot(c.right, c.eye), -dot(c.up, c.eye), dot(c.forward, c.eye), 1];
    const p = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
    const out = new Float32Array(16);
    for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[col * 4 + row] += p[k * 4 + row] * v[col * 4 + k];
    return out;
  }
  function project(x, y, z, m, width, height) {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 0) return null;
    return { x: (1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * width / 2,
      y: (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * height / 2, depth: w };
  }
  function compile(type, source) {
    const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }
  function initWebGL() {
    if (!gl) {
      if (!ctx) { rendererFailed = true; updateViewState(); }
      return;
    }
    try {
      const vertex = compile(gl.VERTEX_SHADER, `
        attribute vec3 position; attribute vec3 normal; attribute vec3 color;
        uniform mat4 cameraMatrix; uniform float viewportHeight; uniform float pointScale;
        varying vec3 tint;
        void main() {
          vec4 clip = cameraMatrix * vec4(position, 1.0);
          gl_Position = clip;
          gl_PointSize = clamp(pointScale * viewportHeight / max(clip.w, 1.0), 1.5, 22.0);
          vec3 light = normalize(vec3(-0.3, 0.5, 0.85));
          float shade = 0.66 + 0.34 * abs(dot(normalize(normal), light));
          tint = color * shade;
        }`);
      const fragment = compile(gl.FRAGMENT_SHADER, `
        precision mediump float; varying vec3 tint;
        uniform float selectionActive; uniform float selectionPass;
        void main() {
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(uv, uv);
          if (r2 > 1.0) discard;
          float alpha = exp(-2.8 * r2);
          vec3 c = mix(tint, vec3(0.769, 0.478, 0.157), selectionPass * 0.7);
          gl_FragColor = vec4(c, alpha * (selectionActive > 0.5 && selectionPass < 0.5 ? 0.24 : 1.0));
        }`);
      program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.deleteShader(vertex); gl.deleteShader(fragment);
      attributes = ['position', 'normal', 'color'].map(name => gl.getAttribLocation(program, name));
      uniforms = Object.fromEntries(['cameraMatrix', 'viewportHeight', 'pointScale', 'selectionActive', 'selectionPass'].map(name => [name, gl.getUniformLocation(program, name)]));
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } catch {
      program = null;
      rendererFailed = true; updateViewState();
    }
  }
  function requestDraw() { if (!framePending) { framePending = true; requestAnimationFrame(draw); } }
  function bindPoints(buffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const stride = STRIDE * 4;
    [[0, 3, 0], [1, 3, 12], [2, 3, 24]].forEach(([i, n, offset]) => {
      if (attributes[i] < 0) return;
      gl.enableVertexAttribArray(attributes[i]); gl.vertexAttribPointer(attributes[i], n, gl.FLOAT, false, stride, offset);
    });
  }
  function draw() {
    framePending = false;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio)), height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    if (gl && program) {
      gl.viewport(0, 0, width, height); gl.clearColor(33 / 255, 31 / 255, 29 / 255, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!state.chunks.length && !state.tileChunks.length) return;
      gl.useProgram(program);
      gl.uniformMatrix4fv(uniforms.cameraMatrix, false, viewProjection(width / height));
      gl.uniform1f(uniforms.viewportHeight, height);
      gl.uniform1f(uniforms.pointScale, Math.max(1, state.radius * .009 * Math.sqrt(4096 / Math.max(4096, state.count))));
      const hasSelection = state.selectionScopes.length || state.selectedIndex >= 0 ||
        state.highlightedNodeIndex >= 0 || state.selectedClusterIndex >= 0;
      gl.uniform1f(uniforms.selectionActive, hasSelection ? 1 : 0);
      const plan = visibleRenderPlan(width, height);
      gl.uniform1f(uniforms.selectionPass, 0);
      for (const { chunk, count } of plan) {
        if (!count || !chunk.buffer) continue;
        bindPoints(chunk.buffer);
        gl.drawArrays(gl.POINTS, 0, count);
      }
      if (hasSelection) {
        // Only the selected cohort is replayed, at its real depth. This avoids
        // a second all-point draw and keeps a foreground surface in front.
        const overlays = plan.flatMap(({ chunk }) => chunk.renderTile ? chunk.tile.chunks : [chunk]);
        const totalSelected = overlays.reduce((sum, chunk) => sum + (chunk.selectedCount || 0), 0);
        const fraction = Math.min(1, MAX_SELECTED_DRAW_POINTS / Math.max(1, totalSelected));
        gl.depthMask(false);
        gl.uniform1f(uniforms.selectionPass, 1);
        for (const chunk of overlays) {
          if (!chunk.selectedCount || !chunk.selectedBuffer) continue;
          bindPoints(chunk.selectedBuffer);
          gl.drawArrays(gl.POINTS, 0, Math.ceil(chunk.selectedCount * fraction));
        }
        gl.depthMask(true);
      }
    } else if (ctx) {
      ctx.fillStyle = '#211F1D'; ctx.fillRect(0, 0, width, height);
      const m = viewProjection(width / height), points = [];
      forEachCanvasSample((chunk, i) => {
        const p = i * STRIDE, q = project(chunk.data[p], chunk.data[p + 1], chunk.data[p + 2], m, width, height);
        if (q && q.x >= 0 && q.x < width && q.y >= 0 && q.y < height) points.push({ ...q, data: chunk.data, p });
      });
      points.sort((a, b) => b.depth - a.depth);
      const densityScale = Math.sqrt(4000 / Math.max(4000, state.count));
      const paint = q => {
        const d = q.data, p = q.p, selected = d[p + HIGHLIGHT] > .5;
        const size = clamp(state.radius * .0085 * height / Math.max(q.depth, 1) * densityScale, .9, 2.8);
        const normalShade = Math.abs(d[p + 3] * -.35 + d[p + 4] * .45 + d[p + 5] * .82);
        const minZ = state.worldBounds?.min?.[2] ?? 0, maxZ = state.worldBounds?.max?.[2] ?? 1;
        const elevation = clamp((d[p + 2] + state.originCm[2] - minZ) / Math.max(maxZ - minZ, 1), 0, 1);
        const shade = .76 + .22 * normalShade + .12 * elevation;
        ctx.fillStyle = selected ? '#C47429' : `rgb(${Math.min(255, Math.round(d[p + 6] * 255 * shade))},${Math.min(255, Math.round(d[p + 7] * 255 * shade))},${Math.min(255, Math.round(d[p + 8] * 255 * shade))})`;
        ctx.globalAlpha = selected ? .98 : state.selectionScopes.length ? .22 : .86;
        ctx.beginPath(); ctx.arc(q.x, q.y, size, 0, Math.PI * 2); ctx.fill();
      };
      for (const q of points) paint(q);
      ctx.globalAlpha = 1;
    }
  }
  function lodFraction() {
    if (state.count < 20000) return 1;
    const ratio = state.distance / state.fittedDistance;
    return ratio > 2.5 ? .25 : ratio > 1.5 ? .5 : 1;
  }
  function lodCount(count) {
    return Math.max(1, Math.ceil(count * lodFraction()));
  }
  function visibleChunkCounts() {
    const depthBudget = Math.ceil(state.depthPointCount * lodFraction());
    let depthSeen = 0;
    return state.chunks.map(chunk => {
      if (!chunk.isDepth) return lodCount(chunk.count);
      const visible = Math.max(0, Math.min(chunk.count, depthBudget - depthSeen));
      depthSeen += chunk.count;
      return visible;
    });
  }
  function desiredTileLod() {
    if (!state.done || !state.userMoved || state.worldState === 'failed' || state.worldState === 'no_world') return -1;
    return state.distance <= 2500 ? 2 : state.distance <= 5500 ? 1 : state.distance <= 12000 ? 0 : -1;
  }
  function tileIdAt(lod, point) {
    const edge = 4000 / (1 << lod);
    return `tile:${lod}:${Math.floor(point[0] / edge)}:${Math.floor(point[1] / edge)}:${Math.floor(point[2] / edge)}`;
  }
  function tileOnScreen(tile, matrix, width, height) {
    const bounds = tile.boundsCm;
    if (!bounds || !finite3(bounds.min) || !finite3(bounds.max)) return false;
    const center = bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2 - state.originCm[axis]);
    const pixel = project(...center, matrix, width, height);
    if (!pixel) return false;
    const radius = Math.hypot(...bounds.max.map((value, axis) => value - bounds.min[axis])) / 2;
    const margin = radius * height * 1.8 / Math.max(1, pixel.depth);
    return pixel.x >= -margin && pixel.x <= width + margin && pixel.y >= -margin && pixel.y <= height + margin;
  }
  function visibleTileChunks(width = canvas.clientWidth, height = canvas.clientHeight) {
    const lod = desiredTileLod();
    if (lod < 0) return [];
    const matrix = viewProjection(width / Math.max(1, height));
    const tiles = [...state.tiles.values()].filter(tile => tile.lod === lod && tile.chunks.length &&
      tileOnScreen(tile, matrix, width, height));
    tiles.sort((a, b) => {
      const distance2 = tile => tile.boundsCm.min.reduce((sum, value, axis) => {
        const center = (value + tile.boundsCm.max[axis]) / 2 - state.originCm[axis] - state.target[axis];
        return sum + center * center;
      }, 0);
      return distance2(a) - distance2(b);
    });
    return tiles.map(tile => tile.renderChunk).filter(chunk => chunk.count > 0);
  }
  function visibleRenderPlan(width = canvas.clientWidth, height = canvas.clientHeight) {
    const baseCounts = visibleChunkCounts();
    const tiles = visibleTileChunks(width, height);
    const hasTiles = tiles.length > 0;
    const tileCount = tiles.reduce((sum, chunk) => sum + chunk.count, 0);
    const baseCount = baseCounts.reduce((sum, count) => sum + count, 0);
    const baseBudget = Math.min(hasTiles ? MAX_BASE_DRAW_POINTS_WITH_TILES : MAX_GPU_DRAW_POINTS,
      MAX_GPU_DRAW_POINTS - Math.min(tileCount, MAX_GPU_DRAW_POINTS / 2));
    const baseFraction = Math.min(1, baseBudget / Math.max(1, baseCount));
    const plan = state.chunks.map((chunk, index) => ({ chunk, count: Math.floor(baseCounts[index] * baseFraction) }));
    let baseRemaining = Math.min(baseCount, baseBudget) - plan.reduce((sum, item) => sum + item.count, 0);
    for (let index = 0; index < plan.length && baseRemaining > 0; index++) {
      const item = plan[index];
      if (item.count >= baseCounts[index]) continue;
      item.count++; baseRemaining--;
    }
    let remaining = MAX_GPU_DRAW_POINTS - plan.reduce((sum, item) => sum + item.count, 0);
    for (const chunk of tiles) {
      const count = Math.min(chunk.count, remaining);
      if (count > 0) plan.push({ chunk, count });
      remaining -= count;
    }
    return plan;
  }
  // Each prefix is already spatially distributed by lodOrder. Sample evenly
  // across those visible prefixes without scanning or drawing excess points.
  function forEachCanvasSample(visit) {
    const plan = visibleRenderPlan();
    const counts = plan.map(item => item.count);
    const visibleCount = counts.reduce((sum, count) => sum + count, 0);
    const budget = state.distance < state.fittedDistance * .75 ? DETAIL_CANVAS_POINTS : OVERVIEW_CANVAS_POINTS;
    const sampleCount = Math.min(visibleCount, budget);
    let chunkIndex = 0, chunkStart = 0;
    for (let sample = 0; sample < sampleCount; sample++) {
      const index = Math.floor((sample + .5) * visibleCount / sampleCount);
      while (index >= chunkStart + counts[chunkIndex]) {
        chunkStart += counts[chunkIndex++];
      }
      visit(plan[chunkIndex].chunk, index - chunkStart);
    }
  }
  // A dyadic permutation puts an even overview at the front of each buffer.
  // Drawing a prefix is then a real point LOD without a second GPU copy.
  function lodOrder(length) {
    let bits = 0;
    while ((1 << bits) < length) bits++;
    const indices = [];
    for (let i = 0; i < (1 << bits); i++) {
      let value = i, reversed = 0;
      for (let bit = 0; bit < bits; bit++) { reversed = (reversed << 1) | (value & 1); value >>= 1; }
      if (reversed < length) indices.push(reversed);
    }
    return indices;
  }
  let fitCache = null;
  function fitDistance() {
    const aspect = Math.max(.1, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    // Use a conservative sphere until observed bounds arrive. Once they do,
    // fit the points themselves: source bounds can include empty space or miss
    // transformed samples, while these positions are exactly what we draw.
    const fallbackDistance = Math.max(150, state.radius * Math.max(3, 2.4 / aspect));
    let distance = 150;
    const c = camera(), tanVertical = Math.tan(Math.PI / 6) * .8;
    const tanHorizontal = tanVertical * aspect;
    const frontMargin = Math.max(1, state.radius * .05);
    // These five maxima are linear in each point. Keep them across streamed
    // pages, then adjust for the moving target without rescanning old buffers.
    if (!fitCache || fitCache.aspect !== aspect || fitCache.yaw !== state.yaw || fitCache.pitch !== state.pitch ||
        fitCache.chunkCount > state.chunks.length ||
        (fitCache.chunkCount && (fitCache.lastChunk !== state.chunks[fitCache.chunkCount - 1] ||
          fitCache.lastChunkCount !== fitCache.lastChunk.count))) {
      fitCache = { aspect, yaw: state.yaw, pitch: state.pitch, chunkCount: 0, lastChunk: null,
        rightPlus: -Infinity, rightMinus: -Infinity, upPlus: -Infinity, upMinus: -Infinity, front: -Infinity };
    }
    for (let chunkIndex = fitCache.chunkCount; chunkIndex < state.chunks.length; chunkIndex++) {
      const chunk = state.chunks[chunkIndex];
      if (!chunk.data) continue;
      for (let i = 0; i < chunk.count; i++) {
        const p = i * STRIDE, x = chunk.data[p], y = chunk.data[p + 1], z = chunk.data[p + 2];
        const along = x * c.forward[0] + y * c.forward[1] + z * c.forward[2];
        const right = x * c.right[0] + y * c.right[1] + z * c.right[2];
        const up = x * c.up[0] + y * c.up[1] + z * c.up[2];
        fitCache.rightPlus = Math.max(fitCache.rightPlus, right / tanHorizontal - along);
        fitCache.rightMinus = Math.max(fitCache.rightMinus, -right / tanHorizontal - along);
        fitCache.upPlus = Math.max(fitCache.upPlus, up / tanVertical - along);
        fitCache.upMinus = Math.max(fitCache.upMinus, -up / tanVertical - along);
        fitCache.front = Math.max(fitCache.front, -along);
      }
    }
    fitCache.chunkCount = state.chunks.length;
    fitCache.lastChunk = state.chunks[state.chunks.length - 1] || null;
    fitCache.lastChunkCount = fitCache.lastChunk?.count || 0;
    if (fitCache.front > -Infinity) {
      const targetRight = dot(state.target, c.right), targetUp = dot(state.target, c.up);
      const targetAlong = dot(state.target, c.forward);
      return Math.max(distance, fitCache.front + targetAlong + frontMargin,
        fitCache.rightPlus - targetRight / tanHorizontal + targetAlong,
        fitCache.rightMinus + targetRight / tanHorizontal + targetAlong,
        fitCache.upPlus - targetUp / tanVertical + targetAlong,
        fitCache.upMinus + targetUp / tanVertical + targetAlong);
    }
    const bounds = state.worldBounds;
    if (!bounds || bounds.valid === false) return fallbackDistance;
    for (let corner = 0; corner < 8; corner++) {
      const relative = [0, 1, 2].map(axis =>
        (corner & (1 << axis) ? bounds.max[axis] : bounds.min[axis]) - state.originCm[axis] - state.target[axis]);
      const along = dot(relative, c.forward);
      distance = Math.max(distance,
        -along + frontMargin,
        Math.abs(dot(relative, c.right)) / tanHorizontal - along,
        Math.abs(dot(relative, c.up)) / tanVertical - along);
    }
    return distance;
  }
  function focusFit() {
    const xs = new Float32Array(state.count), ys = new Float32Array(state.count), zs = new Float32Array(state.count);
    let count = 0;
    for (const chunk of state.chunks) {
      if (!chunk.data) continue;
      for (let i = 0; i < chunk.count; i++) {
        const p = i * STRIDE;
        xs[count] = chunk.data[p]; ys[count] = chunk.data[p + 1]; zs[count] = chunk.data[p + 2]; count++;
      }
    }
    if (count < 32) return null;
    const x = xs.subarray(0, count).sort(), y = ys.subarray(0, count).sort(), z = zs.subarray(0, count).sort();
    const percentile = (sorted, share) => sorted[Math.floor((count - 1) * share)];
    const low = .05, high = .95;
    const target = [x, y, z].map(sorted => (percentile(sorted, low) + percentile(sorted, high)) / 2);
    const coreBoundsCm = { valid: true,
      min: [x, y, z].map((sorted, axis) => percentile(sorted, .01) + state.originCm[axis]),
      max: [x, y, z].map((sorted, axis) => percentile(sorted, .99) + state.originCm[axis]) };
    const focusRadius = Math.hypot(...[x, y, z].map(sorted => percentile(sorted, high) - percentile(sorted, low))) / 2;
    const aspect = Math.max(.1, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    const tanVertical = Math.tan(Math.PI / 6) * .75, tanHorizontal = tanVertical * aspect;
    const c = defaultFitBasis(), frontMargin = Math.max(1, focusRadius * .05);
    const required = new Float64Array(count);
    let index = 0;
    for (const chunk of state.chunks) {
      if (!chunk.data) continue;
      for (let i = 0; i < chunk.count; i++) {
        const p = i * STRIDE, px = chunk.data[p] - target[0];
        const py = chunk.data[p + 1] - target[1], pz = chunk.data[p + 2] - target[2];
        const along = px * c.forward[0] + py * c.forward[1] + pz * c.forward[2];
        const right = px * c.right[0] + py * c.right[1] + pz * c.right[2];
        const up = px * c.up[0] + py * c.up[1] + pz * c.up[2];
        required[index++] = Math.max(-along + frontMargin,
          Math.abs(right) / tanHorizontal - along, Math.abs(up) / tanVertical - along);
      }
    }
    required.sort();
    const core = required[Math.floor((count - 1) * .9)];
    const fringe = required[Math.floor((count - 1) * .95)];
    // Leave space around the dominant mass without letting the far depth tail
    // collapse it into a tiny patch. Fit all remains available on demand.
    const distance = Math.max(150, core * 1.18, Math.min(fringe, core * 1.35));
    return { target, distance, aspect, count, coreBoundsCm };
  }
  function fit(mode = state.fitMode) {
    state.userMoved = false;
    state.fitMode = mode;
    state.target = state.center.slice(); state.yaw = -.75; state.pitch = .36;
    if (mode === 'focus' && state.focusFit) {
      const aspect = Math.max(.1, canvas.clientWidth / Math.max(1, canvas.clientHeight));
      if (state.focusFit.aspect !== aspect || state.focusFit.count !== state.count) state.focusFit = focusFit();
      if (state.focusFit) {
        state.target = state.focusFit.target.slice();
        state.fittedDistance = state.distance = state.focusFit.distance;
        requestDraw(); return;
      }
    }
    state.fittedDistance = fitDistance(); state.distance = state.fittedDistance; requestDraw();
  }
  function validIndex(index, list) { return Number.isSafeInteger(index) && index >= 0 && index < list.length; }
  function descendantsFromRoots(list, roots) {
    const matches = new Set();
    const queue = [...roots].filter(index => validIndex(index, list));
    if (!queue.length) return matches;
    const children = new Map();
    list.forEach((item, index) => {
      const at = item.parentIndex;
      if (validIndex(at, list)) {
        if (!children.has(at)) children.set(at, []);
        children.get(at).push(index);
      }
    });
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const at = queue[cursor];
      if (matches.has(at)) continue;
      matches.add(at);
      for (const child of children.get(at) || []) queue.push(child);
    }
    return matches;
  }
  function descendants(list, parent) { return descendantsFromRoots(list, [parent]); }
  function clearScopes() {
    state.pointSelection = null;
    state.selectionScopes = [];
    state.selectionEvidence = null;
    state.scopeIndex = 0;
    scopeRail.hidden = true;
    scopeCopy.replaceChildren();
  }
  function sourceForPoint(chunk, pointIndex) {
    if (chunk.renderTile) {
      const pageChunk = chunk.tile.chunks.find(item => pointIndex >= item.rowOffset &&
        pointIndex < item.rowOffset + item.count);
      if (!pageChunk) return { provenance: 'cpu_render_lod', tileId: chunk.tile.id };
      return sourceForPoint(pageChunk, pointIndex - pageChunk.rowOffset);
    }
    const data = chunk.data, p = pointIndex * STRIDE;
    const actors = chunk.page?.actors || state.actors, nodes = chunk.page?.nodes || state.nodes;
    return { actorIndex: data[p + ACTOR], nodeIndex: data[p + NODE], clusterIndex: data[p + CLUSTER],
      actor: actors[data[p + ACTOR]], node: nodes[data[p + NODE]], actors, nodes,
      provenance: chunk.isDepth ? 'view_depth' : 'cpu_render_lod', tileId: chunk.tile?.id || null,
      captureId: chunk.tile?.captureId || null,
      pageId: chunk.page?.pageId ?? null, rowIndex: (chunk.rowOffset || 0) + pointIndex };
  }
  function semanticValue(source, kind) {
    if (kind === 'actor') return source.actor?.path || '';
    const node = source.node;
    if (!node) return kind === 'tag' ? [] : '';
    const chain = ancestry(source.nodes, source.nodeIndex);
    if (kind === 'node') return chain.map(index => source.nodes[index]?.id).filter(Boolean);
    if (kind === 'asset') return chain.map(index => source.nodes[index]?.meshAsset).filter(Boolean);
    if (kind === 'tag') return chain.flatMap(index => source.nodes[index]?.tags || []);
    return '';
  }
  function semanticMatches(scope, chunk, pointIndex) {
    const source = sourceForPoint(chunk, pointIndex);
    const value = semanticValue(source, scope.semanticKind);
    return Array.isArray(value) ? value.includes(scope.value) : value === scope.value;
  }
  function tileScopesForPoint(point) {
    const source = sourceForPoint(point.chunk, point.index), scopes = [];
    const add = (kind, value, label, provenance) => {
      if (value && !scopes.some(scope => scope.key === `${kind}:${value}`))
        scopes.push({ key: `${kind}:${value}`, label, provenance, type: 'semantic', semanticKind: kind, value });
    };
    for (const index of ancestry(source.nodes, source.nodeIndex)) {
      const node = source.nodes[index];
      if (node.kind === 'world') continue;
      add('node', node.id, `${nodeKind(node.kind)} · ${labelOf(node, 'Source')}`, 'CPU mesh source');
    }
    add('actor', source.actor?.path, `Actor · ${labelOf(source.actor, 'Selected actor')}`, 'CPU mesh source');
    for (const tag of semanticValue(source, 'tag').slice(0, 4)) add('tag', tag, `Tag · ${tag}`, 'Authored tag');
    for (const asset of semanticValue(source, 'asset').slice(0, 2))
      add('asset', asset, `Mesh · ${asset.split('/').pop()}`, 'Shared mesh asset');
    for (const index of ancestry(state.clusters, source.clusterIndex)) {
      if (!index) continue;
      const group = state.clusters[index];
      scopes.push({ key: `cluster:${index}`, label: group.level === 2 ? 'Nearby surfaces' : 'Area surfaces',
        provenance: 'Derived from mesh sample positions', type: 'clusters', matches: descendants(state.clusters, index) });
    }
    if (!scopes.some(scope => scope.type === 'clusters')) {
      const p = point.index * STRIDE, position = [0, 1, 2].map(axis =>
        point.chunk.data[p + axis] + state.originCm[axis]);
      for (let lod = 0; lod <= point.chunk.tile.lod; lod++) {
        const value = tileIdAt(lod, position);
        scopes.push({ key: `region:${value}`, label: lod === 0 ? 'Area surfaces' :
          lod === 1 ? 'Nearby surfaces' : 'Local surfaces',
        provenance: 'Derived from CPU mesh positions', type: 'tiles', lod, value });
      }
    }
    return scopes;
  }
  function scopesForPoint(point) {
    const scopes = [], used = new Set();
    const add = (key, label, provenance, type, matches, semanticKind = null, value = null) => {
      if (!matches || !matches.size || used.has(key)) return;
      used.add(key);
      const scope = { key, label, provenance, type, matches, semanticKind, value };
      if (type === 'nodes') scope.nodeIds = new Set([...matches].map(index => state.nodes[index]?.id).filter(Boolean));
      if (type === 'actors') scope.actorPaths = new Set([...matches].map(index => state.actors[index]?.path).filter(Boolean));
      scopes.push(scope);
    };
    if (validIndex(point.nodeIndex, state.nodes)) {
      const chain = ancestry(state.nodes, point.nodeIndex).reverse();
      for (const index of chain) {
        const node = state.nodes[index];
        if (node.kind === 'world') continue;
        add(`node:${index}`, `${nodeKind(node.kind)} · ${labelOf(node, 'Source')}`,
          point.isDepth ? 'Depth-matched source · verify in editor' : 'Authored hierarchy',
          'nodes', descendants(state.nodes, index));
      }
      const tags = new Set(), assets = new Set();
      for (const index of chain) {
        const node = state.nodes[index];
        if (node.kind === 'world') continue;
        for (const tag of Array.isArray(node.tags) ? node.tags : [])
          if (typeof tag === 'string' && tag && tags.size < 4) tags.add(tag);
        if (typeof node.meshAsset === 'string' && node.meshAsset) assets.add(node.meshAsset);
      }
      for (const tag of tags) {
        const roots = [];
        state.nodes.forEach((node, index) => {
          if (Array.isArray(node.tags) && node.tags.includes(tag)) roots.push(index);
        });
        add(`tag:${tag}`, `Tag · ${tag}`, 'Authored tag', 'semantic',
          descendantsFromRoots(state.nodes, roots), 'tag', tag);
      }
      for (const asset of assets) {
        const roots = [];
        state.nodes.forEach((node, index) => {
          if (node.meshAsset === asset) roots.push(index);
        });
        add(`asset:${asset}`, `Mesh · ${asset.split('/').pop()}`, 'Shared mesh asset', 'semantic',
          descendantsFromRoots(state.nodes, roots), 'asset', asset);
      }
    }
    if (validIndex(point.actorIndex, state.actors) && !scopes.some(scope => scope.key.startsWith('node:') &&
      state.nodes[Number(scope.key.slice(5))]?.kind === 'actor'))
      add(`actor:${point.actorIndex}`, `Actor · ${labelOf(state.actors[point.actorIndex], 'Selected actor')}`,
        point.isDepth ? 'Depth-matched actor · verify in editor' : 'Authored actor',
        'actors', new Set([point.actorIndex]));
    for (const index of ancestry(state.clusters, point.clusterIndex).reverse()) {
      const cluster = state.clusters[index];
      if (cluster.level === 0) continue;
      add(`cluster:${index}`, cluster.kind === 'outside_core' ? 'Beyond main scene' :
        cluster.level === 2 ? 'Nearby surfaces' : 'Area surfaces',
        point.isDepth ? 'Derived from view-depth observations' : 'Derived from CPU mesh samples',
        'clusters', descendants(state.clusters, index));
    }
    return scopes;
  }
  function renderScope() {
    scopeRail.hidden = !state.selectionScopes.length;
    selectedLabel.hidden = !!state.selectionScopes.length || !!state.pointSelection;
    scopeCopy.replaceChildren();
    if (!state.selectionScopes.length) return;
    const scope = state.selectionScopes[state.scopeIndex];
    const label = document.createElement('span'); label.textContent = scope.label;
    const index = document.createElement('small'); index.textContent = `${state.scopeIndex + 1}/${state.selectionScopes.length}`;
    scopeCopy.append(label, index);
    scopeRail.title = `${scope.provenance} · Scroll here or Alt-scroll World to change group`;
  }
  function selectScope(index) {
    if (!state.selectionScopes.length) return;
    state.scopeIndex = (index + state.selectionScopes.length) % state.selectionScopes.length;
    renderScope(); updateHighlights();
  }
  function refreshPointScopes() {
    const picked = state.pointSelection;
    if (!picked || !(state.chunks.includes(picked.chunk) || state.tileChunks.includes(picked.chunk) ||
      picked.chunk.renderTile && state.tiles.get(picked.chunk.tile.id)?.renderChunk === picked.chunk) ||
      picked.index >= picked.chunk.count) return;
    const p = picked.index * STRIDE, data = picked.chunk.data;
    const previousKey = state.selectionScopes[state.scopeIndex]?.key;
    state.selectionScopes = picked.chunk.isTile ? tileScopesForPoint(picked) :
      scopesForPoint({ actorIndex: data[p + ACTOR], nodeIndex: data[p + NODE],
        clusterIndex: data[p + CLUSTER], isDepth: picked.chunk.isDepth });
    const sameScope = state.selectionScopes.findIndex(scope => scope.key === previousKey);
    state.scopeIndex = sameScope >= 0 ? sameScope :
      Math.min(state.scopeIndex, Math.max(0, state.selectionScopes.length - 1));
    state.inspectCluster = validIndex(data[p + CLUSTER], state.clusters) ? data[p + CLUSTER] : -1;
    renderScope(); updateHighlights();
  }
  function updateHighlights(onlyChunk = null) {
    const nodeMatches = descendants(state.nodes, state.highlightedNodeIndex);
    const clusterMatches = descendants(state.clusters, state.selectedClusterIndex);
    const activeScope = state.selectionScopes[state.scopeIndex];
    // A streamed chunk needs its own highlight state, not a GPU re-upload of
    // every previously received point. Selection changes still use a full pass.
    const chunkBudget = Math.max(1, Math.ceil(MAX_SELECTED_DRAW_POINTS /
      Math.max(1, state.chunks.length + state.tileChunks.length)));
    for (const chunk of onlyChunk ? [onlyChunk] : [...state.chunks, ...state.tileChunks]) {
      const selectedRows = [];
      for (let i = 0; i < chunk.count; i++) {
        const p = i * STRIDE;
        const selected = activeScope ? activeScope.type === 'semantic' ? semanticMatches(activeScope, chunk, i) :
          activeScope.type === 'nodes' ? chunk.isTile ? activeScope.nodeIds.has(sourceForPoint(chunk, i).node?.id) :
            activeScope.matches.has(chunk.data[p + NODE]) :
            activeScope.type === 'actors' ? chunk.isTile ? activeScope.actorPaths.has(sourceForPoint(chunk, i).actor?.path) :
              activeScope.matches.has(chunk.data[p + ACTOR]) :
              activeScope.type === 'tiles' ? !chunk.isDepth && tileIdAt(activeScope.lod,
                [0, 1, 2].map(axis => chunk.data[p + axis] + state.originCm[axis])) === activeScope.value :
                activeScope.matches.has(chunk.data[p + CLUSTER]) :
          state.highlightedNodeIndex >= 0 ? !chunk.isTile && nodeMatches.has(chunk.data[p + NODE]) :
          state.selectedIndex >= 0 ? !chunk.isTile && chunk.data[p + ACTOR] === state.selectedIndex :
          state.selectedClusterIndex >= 0 && clusterMatches.has(chunk.data[p + CLUSTER]);
        chunk.data[p + HIGHLIGHT] = selected ? 1 : 0;
        // A broad cohort can contain millions of points. Keep its CPU flag
        // exact while storing only a bounded visual overlay per source chunk.
        if (selected && selectedRows.length < chunkBudget) selectedRows.push(i);
      }
      const previousSelectedCount = chunk.selectedCount || 0;
      chunk.selectedCount = selectedRows.length;
      if (gl && program) {
        if (!selectedRows.length && !previousSelectedCount) continue;
        if (!chunk.selectedBuffer) chunk.selectedBuffer = gl.createBuffer();
        const selectedData = new Float32Array(selectedRows.length * STRIDE);
        selectedRows.forEach((source, index) => selectedData.set(
          chunk.data.subarray(source * STRIDE, (source + 1) * STRIDE), index * STRIDE));
        gl.bindBuffer(gl.ARRAY_BUFFER, chunk.selectedBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, selectedData, gl.DYNAMIC_DRAW);
      }
    }
    requestDraw();
  }
  function labelOf(item, fallback) { return item && typeof item.label === 'string' && item.label ? item.label : fallback; }
  function nodeKind(kind) {
    return ({ world: 'World', level: 'Level', folder: 'Folder', actor: 'Actor',
      component: 'Mesh component', static_mesh_component: 'Mesh component', instance: 'Instance' })[kind] || 'Source';
  }
  function clusterLabel(index) {
    const group = state.clusters[index];
    if (!group) return 'Spatial group';
    if (group.level === 0) return 'Loaded world';
    if (group.kind === 'outside_core') return 'Beyond main scene';
    return `${group.level === 1 ? 'Area' : 'Cell'} ${index + 1}`;
  }
  function makeButton(label, className, action, meta) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = className;
    const text = document.createElement('span'); text.textContent = label; button.append(text);
    if (meta) { const small = document.createElement('small'); small.textContent = meta; button.append(small); }
    button.addEventListener('click', action);
    return button;
  }
  function addFact(container, text, title) {
    if (!text) return;
    const fact = document.createElement('span'); fact.textContent = text;
    if (title) fact.title = title;
    container.append(fact);
  }
  function addSection(title, indices, label, meta, activate) {
    if (!indices.length) return;
    const heading = document.createElement('div'); heading.className = 'inspect-section'; heading.textContent = title;
    inspectBody.append(heading);
    const appendItems = items => {
      for (const index of items) inspectBody.append(makeButton(label(index), 'inspect-row', () => activate(index), meta(index)));
    };
    let shown = 0;
    const more = makeButton('', 'inspect-row', () => showNext());
    function showNext() {
      const next = Math.min(shown + 32, indices.length);
      appendItems(indices.slice(shown, next)); shown = next;
      more.textContent = `Show ${Math.min(32, indices.length - shown)} more of ${indices.length - shown}`;
      if (shown >= indices.length) more.remove();
    }
    showNext();
    if (shown < indices.length) inspectBody.append(more);
  }
  function ancestry(list, index) {
    const chain = [], seen = new Set();
    while (validIndex(index, list) && list[index] && !seen.has(index)) {
      seen.add(index); chain.unshift(index); index = list[index].parentIndex;
    }
    return chain;
  }
  function focusBounds(bounds) {
    if (!bounds || bounds.valid === false || !finite3(bounds.min) || !finite3(bounds.max)) return;
    const span = bounds.max.map((v, i) => v - bounds.min[i]);
    if (span.some(v => v < 0)) return;
    state.userMoved = true;
    state.target = bounds.min.map((v, i) => (v + bounds.max[i]) / 2 - state.originCm[i]);
    state.distance = Math.max(100, Math.hypot(...span) * 1.4); requestDraw(); scheduleRefinement();
  }
  function visitCluster(index) {
    clearScopes();
    state.inspectCluster = validIndex(index, state.clusters) ? index : -1;
    state.selectedClusterIndex = state.inspectCluster;
    state.selectedIndex = -1; state.highlightedNodeIndex = -1;
    if (state.inspectCluster >= 0) selectedLabel.textContent = clusterLabel(state.inspectCluster);
    if (state.inspectCluster >= 0) focusBounds(state.clusters[state.inspectCluster].boundsCm);
    else fit();
    renderInspector(); updateHighlights();
  }
  function visitNode(index) {
    clearScopes();
    state.inspectNode = validIndex(index, state.nodes) ? index : -1;
    state.selectedNodeIndex = state.inspectNode;
    state.selectedClusterIndex = -1; state.highlightedNodeIndex = state.inspectNode;
    const node = state.nodes[state.inspectNode];
    state.selectedIndex = node && node.kind === 'actor' && validIndex(node.actorIndex, state.actors) ? node.actorIndex : -1;
    if (node) selectedLabel.textContent = labelOf(node, nodeKind(node.kind));
    if (state.selectedIndex >= 0) {
      const actor = state.actors[state.selectedIndex];
      selectedLabel.textContent = labelOf(actor, actor.path || 'Selected actor');
    }
    if (node) focusBounds(node.boundsCm);
    else fit();
    renderInspector(); updateHighlights();
  }
  function openInspector(mode) {
    if (mode) state.inspectMode = mode;
    inspect.hidden = false; exploreButton.setAttribute('aria-expanded', 'true');
    selectedLabel.hidden = true;
    renderInspector();
  }
  function closeInspector() {
    inspect.hidden = true; exploreButton.setAttribute('aria-expanded', 'false');
    selectedLabel.hidden = !!state.selectionScopes.length ||
      state.selectedIndex < 0 && state.highlightedNodeIndex < 0 && state.selectedClusterIndex < 0;
  }
  function renderInspector() {
    if (inspect.hidden) return;
    const spatial = state.inspectMode === 'spatial';
    spatialTab.setAttribute('aria-selected', String(spatial));
    authoredTab.setAttribute('aria-selected', String(!spatial));
    inspectTrail.replaceChildren(); inspectBody.replaceChildren();
    inspectSubtitle.textContent = spatial ? 'Grouped by point position' : 'Authored in the editor';
    const trail = makeButton('World', '', () => spatial ? visitCluster(-1) : visitNode(-1));
    inspectTrail.append(trail);
    if (spatial) {
      const index = state.inspectCluster;
      for (const ancestor of ancestry(state.clusters, index)) {
        const divider = document.createElement('span'); divider.textContent = '/'; inspectTrail.append(divider);
        inspectTrail.append(makeButton(clusterLabel(ancestor), '', () => visitCluster(ancestor)));
      }
      inspectTitle.textContent = index < 0 ? 'Spatial groups' : clusterLabel(index);
      const group = state.clusters[index], facts = document.createElement('div'); facts.className = 'inspect-facts';
      addFact(facts, 'Derived spatial group');
      if (group) {
        if (group.meshSampleCount) addFact(facts, `${group.meshSampleCount} CPU mesh samples`);
        if (group.depthPointCount) addFact(facts, `${group.depthPointCount} view-depth observations`);
        addFact(facts, `${Array.isArray(group.actorIndices) ? group.actorIndices.length : 0} actors`);
        for (const tag of (Array.isArray(group.tags) ? group.tags : []).slice(0, 3)) addFact(facts, `Source tag: ${tag}`);
        if (group.tagsTruncated) addFact(facts, 'More source tags omitted');
      } else {
        addFact(facts, `${state.count - state.depthPointCount} CPU mesh samples; ${state.depthPointCount} view-depth observations`);
        if (state.tilePointCount) addFact(facts, `${state.tilePointCount} resident refined CPU mesh points`);
        addFact(facts, 'Loaded scene; depth covers one visible editor view only');
        addFact(facts, 'Unloaded and occluded surfaces are outside this observation');
        for (const gap of (state.completion?.gaps || []).slice(0, 8))
          addFact(facts, `Scan gap: ${String(gap).replace(/_/g, ' ')}`);
        if (state.completion?.depthCapture) {
          const depth = state.completion.depthCapture;
          addFact(facts, `Depth capture: ${String(depth.status || 'unknown').replace(/_/g, ' ')}`);
          if (state.depthPointCount) addFact(facts, `${depth.attributedPointCount || 0} depth points have depth-matched collision labels`);
        }
      }
      inspectBody.append(facts);
      const children = state.clusters.map((c, i) => c.parentIndex === index ? i : -1).filter(i => i >= 0 && state.clusters[i].splatCount > 0);
      addSection('Spatial groups', children, clusterLabel,
        i => `${state.clusters[i].meshSampleCount || 0} mesh · ${state.clusters[i].depthPointCount || 0} depth`, visitCluster);
      if (group && !children.length) {
        const sources = [...new Set(Array.isArray(group.nodeIndices) ? group.nodeIndices : [])]
          .filter(i => validIndex(i, state.nodes));
        addSection('Authored sources here', sources, i => labelOf(state.nodes[i], 'Source'),
          i => nodeKind(state.nodes[i].kind), i => { state.inspectMode = 'authored'; visitNode(i); });
      }
      if (!group && !children.length) {
        const empty = document.createElement('div'); empty.className = 'inspect-empty';
        empty.textContent = state.done ? 'No observed surface groups.' : 'Scanning observed surfaces…';
        inspectBody.append(empty);
      }
    } else {
      const index = state.inspectNode;
      for (const ancestor of ancestry(state.nodes, index)) {
        const divider = document.createElement('span'); divider.textContent = '/'; inspectTrail.append(divider);
        inspectTrail.append(makeButton(labelOf(state.nodes[ancestor], nodeKind(state.nodes[ancestor].kind)), '', () => visitNode(ancestor)));
      }
      const node = state.nodes[index];
      inspectTitle.textContent = node ? labelOf(node, nodeKind(node.kind)) : 'Authored sources';
      inspectTitle.title = node && node.path ? node.path : '';
      const facts = document.createElement('div'); facts.className = 'inspect-facts';
      if (node) {
        addFact(facts, nodeKind(node.kind));
        addFact(facts, node.splatCount > 0 ? `${node.splatCount} mesh samples` : 'No sampled mesh surface');
        if (node.actorClass) addFact(facts, `Class: ${node.actorClass}`, node.actorClass);
        if (node.meshAsset) addFact(facts, `Mesh: ${node.meshAsset.split('/').pop()}`, node.meshAsset);
        if (Number.isSafeInteger(node.instanceIndex) && node.instanceIndex >= 0) addFact(facts, `Instance ${node.instanceIndex}`);
        for (const tag of (Array.isArray(node.tags) ? node.tags : []).slice(0, 3)) addFact(facts, `Tag: ${tag}`);
        if (node.tagsTruncated) addFact(facts, 'More tags omitted');
      } else addFact(facts, 'Loaded editor hierarchy');
      inspectBody.append(facts);
      if (node && validIndex(node.actorIndex, state.actors) && state.nativeSelection)
        inspectBody.append(makeButton('Select actor in editor', 'inspect-row', () =>
          { window.location.href = `hayba-scene-map://select/${state.generation}/${node.actorIndex}`; }));
      const children = state.nodes.map((n, i) => n.parentIndex === index ? i : -1).filter(i => i >= 0);
      addSection('Contains', children, i => labelOf(state.nodes[i], nodeKind(state.nodes[i].kind)),
        i => nodeKind(state.nodes[i].kind), visitNode);
      if (!node && !children.length) {
        const empty = document.createElement('div'); empty.className = 'inspect-empty';
        empty.textContent = state.done ? 'No supported authored sources in this scan.' : 'Scanning loaded sources…';
        inspectBody.append(empty);
      }
    }
  }
  window.haybaLoadGeometry = function (data) {
    if (!data || !Number.isSafeInteger(data.generation) || !finite3(data.originCm)) {
      // The native generation may already have advanced. Old points and
      // selection IDs no longer belong to a valid observation; a document
      // reload asks the native host for a fresh scan without guessing its ID.
      for (const chunk of state.chunks) releaseChunk(chunk);
      clearTiles();
      state.generation = null; state.nativeSelection = false; state.actors = [];
      state.nodes = []; state.clusters = []; state.chunks = [];
      state.count = state.depthPointCount = 0; state.pending = null;
      state.done = false; state.completion = null; state.worldBounds = null; state.focusFit = null;
      state.spatialGrid = null; state.fitMode = 'focus';
      state.selectedIndex = state.selectedNodeIndex = state.highlightedNodeIndex = state.selectedClusterIndex = -1;
      state.inspectNode = state.inspectCluster = -1; selectedLabel.hidden = true;
      clearScopes();
      window.clearTimeout(stallTimer); requestDraw(); renderInspector();
      state.worldState = 'failed'; updateViewState(); return;
    }
    if (state.generation !== null && data.generation < state.generation) return;
    for (const chunk of state.chunks) releaseChunk(chunk);
    clearTiles();
    state.generation = data.generation; state.coverage = data.coverage || {}; state.actors = [];
    state.coverage.actorIteratorComplete = false;
    state.coverage.truncated = false;
    state.coverage.unsupportedByKind ||= {};
    state.worldBounds = null;
    state.nodes = [{ id: 'loaded-world', parentIndex: -1, kind: 'world', label: 'Loaded world', actorIndex: -1, boundsCm: { valid: false } }];
    state.clusters = [{ id: 'spatial:loaded-world', parentIndex: -1, level: 0, splatCount: 0,
      actorIndices: [], nodeIndices: [], boundsCm: { valid: false }, tags: [] }];
    state.pending = null; state.completion = null; state.focusFit = null; state.spatialGrid = null; state.fitMode = 'focus';
    state.worldState = data.worldState === 'no_world' ? 'no_world' : 'loading'; state.noticeDismissed = false;
    state.originCm = data.originCm;
    state.nativeSelection = data.nativeSelection === true; state.chunks = []; state.count = 0; state.depthPointCount = 0; state.done = false;
    state.userMoved = false;
    state.selectedIndex = -1; state.selectedNodeIndex = -1; state.highlightedNodeIndex = -1; state.selectedClusterIndex = -1;
    state.inspectNode = -1; state.inspectCluster = -1;
    selectedLabel.hidden = true;
    clearScopes();
    const bounds = data.boundsCm;
    if (bounds && bounds.valid !== false && finite3(bounds.min) && finite3(bounds.max)) {
      state.center = bounds.min.map((v, i) => (v + bounds.max[i]) / 2 - data.originCm[i]);
      state.radius = Math.max(1, Math.hypot(...bounds.max.map((v, i) => v - bounds.min[i])) / 2);
    } else { state.center = [0, 0, 0]; state.radius = 100; }
    fit(); renderInspector();
    awaitScanProgress(); updateViewState();
  };
  function mergeBounds(previous, next) {
    if (!next || next.valid === false || !finite3(next.min) || !finite3(next.max)) return previous;
    if (!previous || previous.valid === false) return { valid: true, min: next.min.slice(), max: next.max.slice() };
    return { valid: true, min: previous.min.map((v, i) => Math.min(v, next.min[i])),
      max: previous.max.map((v, i) => Math.max(v, next.max[i])) };
  }
  function rebuildSpatialHierarchy() {
    const world = state.worldBounds;
    if (!state.count || !world || world.valid === false) return;
    const root = { id: 'spatial:root', parentIndex: -1, level: 0, boundsCm: { valid: false },
      actorIndices: [], nodeIndices: [], tags: [], splatCount: 0, meshSampleCount: 0,
      depthPointCount: 0, centroidCm: [0, 0, 0] };
    const clusters = [root], coarse = new Map(), fine = new Map(), members = [
      { actors: new Set(), nodes: new Set(), tags: new Set() }];
    // A remote observation must not collapse the scene's useful local cells.
    // Quantiles bound the main observed mass; outside points stay explicit.
    const core = state.focusFit?.coreBoundsCm || world;
    const span = core.max.map((v, i) => Math.max(v - core.min[i], 1));
    function axis(value, min, extent, cells) {
      return Math.max(0, Math.min(cells - 1, Math.floor(cells * (value - min) / extent)));
    }
    function ensure(map, key, parentIndex, level, kind) {
      if (map.has(key)) return map.get(key);
      const index = clusters.length;
      map.set(key, index);
      clusters.push({ id: `spatial:${level}:${key}`, parentIndex, level, kind,
        boundsCm: { valid: false }, actorIndices: [], nodeIndices: [], tags: [],
        splatCount: 0, meshSampleCount: 0, depthPointCount: 0, centroidCm: [0, 0, 0] });
      members.push({ actors: new Set(), nodes: new Set(), tags: new Set() });
      return index;
    }
    for (const chunk of state.chunks) for (let i = 0; i < chunk.count; i++) {
      const p = i * STRIDE, data = chunk.data;
      const point = [0, 1, 2].map(axisIndex => data[p + axisIndex] + state.originCm[axisIndex]);
      const outside = point.map((value, axisIndex) => value < core.min[axisIndex] ? -1 :
        value > core.max[axisIndex] ? 1 : 0);
      let lineage;
      if (outside.some(direction => direction !== 0)) {
        const outsideIndex = ensure(coarse, `outside:${outside.join(':')}`, 0, 1, 'outside_core');
        data[p + CLUSTER] = outsideIndex;
        lineage = [0, outsideIndex];
      } else {
        const x = axis(point[0], core.min[0], span[0], 8);
        const y = axis(point[1], core.min[1], span[1], 8);
        const z = axis(point[2], core.min[2], span[2], 4);
        const coarseKey = `${x >> 1}:${y >> 1}:${z >> 1}`;
        const coarseIndex = ensure(coarse, coarseKey, 0, 1);
        const fineIndex = ensure(fine, `${x}:${y}:${z}`, coarseIndex, 2);
        data[p + CLUSTER] = fineIndex;
        lineage = [0, coarseIndex, fineIndex];
      }
      for (const index of lineage) {
        const cluster = clusters[index], member = members[index];
        cluster.splatCount++;
        if (chunk.isDepth) cluster.depthPointCount++;
        else cluster.meshSampleCount++;
        cluster.boundsCm = mergeBounds(cluster.boundsCm, { valid: true, min: point, max: point });
        for (let axisIndex = 0; axisIndex < 3; axisIndex++) cluster.centroidCm[axisIndex] += point[axisIndex];
        member.actors.add(data[p + ACTOR]);
        member.nodes.add(data[p + NODE]);
      }
    }
    clusters.forEach((cluster, index) => {
      const member = members[index];
      cluster.actorIndices = [...member.actors];
      cluster.nodeIndices = [...member.nodes];
      if (cluster.splatCount) {
        cluster.centroidCm = cluster.centroidCm.map(value => value / cluster.splatCount);
        const bound = cluster.boundsCm;
        cluster.radiusCm = Math.hypot(...bound.max.map((v, axisIndex) =>
          Math.max(Math.abs(v - cluster.centroidCm[axisIndex]), Math.abs(bound.min[axisIndex] - cluster.centroidCm[axisIndex]))));
      }
      for (const nodeIndex of member.nodes) {
        let at = nodeIndex;
        for (let steps = 0; steps < 8 && validIndex(at, state.nodes); steps++) {
          const node = state.nodes[at];
          if (node.tagsTruncated) cluster.tagsTruncated = true;
          for (const tag of node.tags || []) {
            if (member.tags.size < 16) member.tags.add(tag);
            else cluster.tagsTruncated = true;
          }
          at = node.parentIndex;
        }
      }
      cluster.tags = [...member.tags].sort();
    });
    state.clusters = clusters;
    state.spatialGrid = { core, span, coarse, fine };
    state.inspectCluster = state.selectedClusterIndex = -1;
    if (gl && program) for (const chunk of state.chunks) {
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, chunk.data, gl.DYNAMIC_DRAW);
    }
    requestDraw();
  }
  function spatialClusterForPoint(relative) {
    const grid = state.spatialGrid;
    if (!grid) return -1;
    const point = relative.map((value, axis) => value + state.originCm[axis]);
    const outside = point.map((value, axis) => value < grid.core.min[axis] ? -1 :
      value > grid.core.max[axis] ? 1 : 0);
    if (outside.some(direction => direction !== 0))
      return grid.coarse.get(`outside:${outside.join(':')}`) ?? -1;
    const cell = point.map((value, axis) => Math.max(0, Math.min((axis === 2 ? 4 : 8) - 1,
      Math.floor((axis === 2 ? 4 : 8) * (value - grid.core.min[axis]) / grid.span[axis]))));
    return grid.fine.get(cell.join(':')) ?? -1;
  }
  function scheduleRefinement() {
    window.clearTimeout(refineTimer);
    refineTimer = window.setTimeout(() => {
      refineTimer = null;
      const lod = desiredTileLod();
      if (lod < 0 || !Number.isSafeInteger(state.generation)) return;
      const center = state.target.map((value, axis) => value + state.originCm[axis]);
      const edge = 4000 / (1 << lod);
      const offsets = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
        [0, 0, 1], [0, 0, -1]];
      state.refineQueue = offsets.map(offset => tileIdAt(lod, center.map((value, axis) => value + offset[axis] * edge)))
        .filter((id, index, ids) => ids.indexOf(id) === index && !state.tiles.has(id) &&
          id !== state.refineInFlight);
      startNextRefinement();
    }, 100);
  }
  function startNextRefinement() {
    if (state.refineInFlight || state.generation === null) return;
    const tileId = state.refineQueue.shift();
    if (!tileId) return;
    state.refineInFlight = tileId;
    const [, lod, x, y, z] = tileId.split(':');
    window.location.href = `hayba-scene-map://refine/${state.generation}/${lod}/${x}/${y}/${z}`;
    window.clearTimeout(refineTimeout);
    refineTimeout = window.setTimeout(() => {
      if (state.refineInFlight !== tileId) return;
      state.refineInFlight = null;
      if (state.pendingTileSelect?.tileId === tileId && state.pendingTileSelect.retries)
        tileSelectionFailure('Tile refresh timed out.');
      startNextRefinement();
    }, 20000);
  }
  function tileSelectionUrl(pending) {
    const [, lod, x, y, z] = pending.tileId.split(':');
    return `hayba-scene-map://select-tile/${state.generation}/${lod}/${x}/${y}/${z}/` +
      `${pending.pageId}/${pending.actorIndex}`;
  }
  function tileSelectionFailure(detail) {
    state.pendingTileSelect = null;
    showMessage('Source unavailable', detail, 'Refresh', retryScan, true);
  }
  window.haybaTileSelectionResult = function (generation, result) {
    const pending = state.pendingTileSelect;
    if (generation !== state.generation || !pending || !result || result.tileId !== pending.tileId ||
      result.pageId !== pending.pageId || result.actorIndex !== pending.actorIndex) return;
    if (result.selected === true) { state.pendingTileSelect = null; startNextRefinement(); return; }
    if (result.reason === 'not_cached' && pending.retries === 0) {
      if (!pending.actorPath) {
        tileSelectionFailure('This source has no stable actor path. Refresh World to inspect it.');
        return;
      }
      pending.retries = 1;
      state.refineQueue = [pending.tileId, ...state.refineQueue.filter(id => id !== pending.tileId)];
      startNextRefinement(); return;
    }
    const detail = result.reason === 'editor_busy' ? 'The editor is busy. Try selecting again when it is idle.' :
      result.reason === 'world_changed' || result.reason === 'stale_generation' ?
        'The loaded level changed. Refresh World before selecting a source.' :
        'The source is no longer available in the loaded level. Refresh World to inspect it.';
    tileSelectionFailure(detail);
    startNextRefinement();
  };
  window.haybaFocusTile = function (tileId, captureId = null) {
    if (!/^tile:[012]:-?\d+:-?\d+:-?\d+$/.test(tileId) || !state.done ||
      !Number.isSafeInteger(state.generation) || state.worldState === 'failed' ||
      state.worldState === 'no_world' || !state.count && !state.tilePointCount) return false;
    const tile = state.tiles.get(tileId);
    if (captureId && (!tile || tile.captureId !== captureId)) return false;
    const [, lodText, xText, yText, zText] = tileId.split(':');
    const lod = Number(lodText), coords = [xText, yText, zText].map(Number);
    if (coords.some(value => !Number.isSafeInteger(value) || Math.abs(value) > 10000000)) return false;
    const edge = 4000 / (1 << lod);
    state.target = coords.map((value, axis) => (value + .5) * edge - state.originCm[axis]);
    state.distance = state.fittedDistance = edge * 1.5;
    state.userMoved = true;
    state.refineQueue = [tileId, ...state.refineQueue.filter(id => id !== tileId)];
    if (!tile) startNextRefinement();
    requestDraw(); scheduleRefinement();
    return true;
  };
  window.haybaTileBegin = function (generation, info) {
    if (generation !== state.generation || !state.done || !info ||
      !/^tile:[012]:-?\d+:-?\d+:-?\d+$/.test(info.tileId) ||
      !Number.isSafeInteger(info.lod) || info.lod < 0 || info.lod > 2 ||
      Number(info.tileId.split(':')[1]) !== info.lod || !finite3(info.originCm) ||
      !info.boundsCm || !finite3(info.boundsCm.min) || !finite3(info.boundsCm.max)) return;
    if (state.tiles.has(info.tileId)) {
      const previous = state.tiles.get(info.tileId);
      releaseChunk(previous.renderChunk);
      for (const chunk of previous.chunks) {
        releaseChunk(chunk);
        const index = state.tileChunks.indexOf(chunk);
        if (index >= 0) state.tileChunks.splice(index, 1);
        state.tilePointCount -= chunk.count;
        if (state.pointSelection?.chunk === chunk || state.pointSelection?.chunk === previous.renderChunk) clearScopes();
      }
      state.tiles.delete(info.tileId);
    }
    evictOldestTile();
    const tile = { id: info.tileId, captureId: typeof info.captureId === 'string' ? info.captureId : null,
      lod: info.lod, boundsCm: info.boundsCm,
      originCm: info.originCm, pages: new Map(), chunks: [], pointCount: 0, capacity: 0, data: null,
      done: false, partial: false };
    tile.renderChunk = { tile, renderTile: true, isTile: true, count: 0, data: null,
      buffer: gl ? gl.createBuffer() : null, selectedCount: 0 };
    state.tiles.set(info.tileId, tile);
  };
  window.haybaTileAppend = function (generation, tileId, payload) {
    const tile = state.tiles.get(tileId);
    if (generation !== state.generation || !tile || tile.done || !payload ||
      !Number.isSafeInteger(payload.pageId) || payload.pageId < 0 ||
      !Number.isSafeInteger(payload.chunkIndex) || payload.chunkIndex < 0 ||
      !finite3(payload.originCm) || !Array.isArray(payload.splats) || payload.splats.length > 1024 ||
      tile.pointCount >= MAX_TILE_POINTS) return;
    let page = tile.pages.get(payload.pageId);
    if (payload.chunkIndex === 0) {
      if (!Array.isArray(payload.actors) || !Array.isArray(payload.nodes) || page) return;
      page = { pageId: payload.pageId, actors: payload.actors, nodes: payload.nodes };
      tile.pages.set(payload.pageId, page);
    }
    if (!page) return;
    const rows = payload.splats.slice(0, MAX_TILE_POINTS - tile.pointCount);
    const valid = rows.filter(row => Array.isArray(row) && row.length === ROW_FIELDS && row.every(Number.isFinite) &&
      Number.isSafeInteger(row[ACTOR]) && row[ACTOR] >= 0 && row[ACTOR] < page.actors.length &&
      Number.isSafeInteger(row[NODE]) && row[NODE] >= 0 && row[NODE] < page.nodes.length);
    if (!valid.length) return;
    const offset = tile.pointCount;
    const required = offset + valid.length;
    if (required > tile.capacity) {
      const capacity = Math.min(MAX_TILE_POINTS, Math.max(required, tile.capacity ? tile.capacity * 2 : 1024));
      const grown = new Float32Array(capacity * STRIDE);
      if (tile.data) grown.set(tile.data.subarray(0, offset * STRIDE));
      tile.data = grown; tile.capacity = capacity; tile.renderChunk.data = grown;
      for (const previous of tile.chunks)
        previous.data = grown.subarray(previous.rowOffset * STRIDE, (previous.rowOffset + previous.count) * STRIDE);
      if (gl) { gl.bindBuffer(gl.ARRAY_BUFFER, tile.renderChunk.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, grown.byteLength, gl.DYNAMIC_DRAW);
        if (offset) gl.bufferSubData(gl.ARRAY_BUFFER, 0, grown.subarray(0, offset * STRIDE)); }
    }
    const data = tile.data.subarray(offset * STRIDE, required * STRIDE), order = lodOrder(valid.length);
    order.forEach((source, index) => {
      const row = valid[source], at = index * STRIDE;
      const color = warmColor(row, false);
      for (let field = 0; field < ROW_FIELDS; field++) data[at + field] =
        field < 3 ? row[field] + payload.originCm[field] - state.originCm[field] :
          field >= 6 && field <= 8 ? color[field - 6] : row[field];
      data[at + CLUSTER] = spatialClusterForPoint([data[at], data[at + 1], data[at + 2]]);
    });
    if (gl) { gl.bindBuffer(gl.ARRAY_BUFFER, tile.renderChunk.buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, offset * STRIDE * 4, data); }
    const chunk = { buffer: null, data, count: valid.length, isTile: true, isDepth: false,
      tile, page, rowOffset: offset, selectedCount: 0 };
    tile.chunks.push(chunk); state.tileChunks.push(chunk);
    tile.pointCount = required; tile.renderChunk.count = required; state.tilePointCount += valid.length;
    if (state.selectionScopes.length || state.selectedIndex >= 0 || state.selectedClusterIndex >= 0 || state.highlightedNodeIndex >= 0)
      updateHighlights(chunk);
    else requestDraw();
  };
  window.haybaTileDone = function (generation, info) {
    if (generation !== state.generation || !info || !state.tiles.has(info.tileId)) return;
    const tile = state.tiles.get(info.tileId);
    if (tile.captureId && info.captureId && tile.captureId !== info.captureId) return;
    tile.done = true;
    tile.partial = !!info.partial || Number(info.pointCount) !== tile.pointCount;
    tile.gaps = Array.isArray(info.gaps) ? info.gaps.filter(gap => typeof gap === 'string') : [];
    if (state.refineInFlight === tile.id) {
      window.clearTimeout(refineTimeout); refineTimeout = null;
      state.refineInFlight = null;
      state.refineQueue = state.refineQueue.filter(id => id !== tile.id);
      const pending = state.pendingTileSelect;
      if (pending?.tileId === tile.id && pending.retries === 1) {
        const matchedPage = [...tile.pages.values()].map(page => ({ page,
          actorIndex: page.actors.findIndex(actor => actor.path === pending.actorPath) }))
          .find(item => item.actorIndex >= 0);
        if (matchedPage) {
          pending.pageId = matchedPage.page.pageId; pending.actorIndex = matchedPage.actorIndex;
          let matchedChunk = null, matchedIndex = -1;
          for (const chunk of tile.chunks) {
            if (chunk.page !== matchedPage.page) continue;
            for (let index = 0; index < chunk.count; index++) {
              const at = index * STRIDE;
              if (chunk.data[at + ACTOR] !== matchedPage.actorIndex) continue;
              if (!matchedChunk) { matchedChunk = chunk; matchedIndex = index; }
              if (pending.nodeId && chunk.page.nodes[chunk.data[at + NODE]]?.id === pending.nodeId) {
                matchedChunk = chunk; matchedIndex = index; break;
              }
            }
            if (matchedChunk && (!pending.nodeId ||
              matchedChunk.page.nodes[matchedChunk.data[matchedIndex * STRIDE + NODE]]?.id === pending.nodeId)) break;
          }
          if (matchedChunk) {
            state.pointSelection = { chunk: matchedChunk, index: matchedIndex };
            refreshPointScopes();
          }
          window.location.href = tileSelectionUrl(pending);
        } else tileSelectionFailure('The selected source is no longer in this tile.');
      } else startNextRefinement();
    }
    requestDraw();
  };
  function includeBounds(bounds) {
    const merged = mergeBounds(state.worldBounds, bounds);
    if (merged === state.worldBounds) return;
    state.worldBounds = merged;
    state.nodes[0].boundsCm = merged;
    state.clusters[0].boundsCm = merged;
    state.center = merged.min.map((v, i) => (v + merged.max[i]) / 2 - state.originCm[i]);
    state.radius = Math.max(1, Math.hypot(...merged.max.map((v, i) => v - merged.min[i])) / 2);
    if (!state.userMoved) fit();
  }
  window.haybaAppendGeometry = function (generation, data) {
    if (state.done || generation !== state.generation || !data || !Array.isArray(data.actors) || !Array.isArray(data.nodes) || !Array.isArray(data.clusters)) return;
    if (state.worldState === 'failed') { state.worldState = 'loading'; updateViewState(); }
    const actorBase = state.actors.length, nodeBase = state.nodes.length, clusterBase = state.clusters.length;
    const nodeAt = local => local === 0 ? 0 : local >= 0 ? nodeBase + local - 1 : -1;
    const clusterAt = local => local === 0 ? 0 : local >= 0 ? clusterBase + local - 1 : -1;
    state.actors.push(...data.actors.map((actor, index) => ({ ...actor, selectionIndex: actorBase + index })));
    for (let index = 1; index < data.nodes.length; index++) {
      const node = data.nodes[index];
      state.nodes.push({ ...node, parentIndex: nodeAt(node.parentIndex),
        actorIndex: node.actorIndex >= 0 ? actorBase + node.actorIndex : -1 });
    }
    for (let index = 1; index < data.clusters.length; index++) {
      const cluster = data.clusters[index];
      state.clusters.push({ ...cluster, parentIndex: clusterAt(cluster.parentIndex),
        actorIndices: (cluster.actorIndices || []).map(value => actorBase + value),
        nodeIndices: (cluster.nodeIndices || []).map(nodeAt) });
    }
    const c = data.coverage || {}, total = state.coverage;
    for (const key of ['actorCount', 'visitedActorCount', 'eligibleMeshActorCount', 'eligibleMetadataActorCount',
      'selectedActorCount', 'componentCount', 'observedInstanceCount', 'sampledInstanceCount', 'sourceCount'])
      total[key] = (total[key] || 0) + (c[key] || 0);
    for (const [kind, value] of Object.entries(c.unsupportedByKind || {}))
      if (typeof value === 'number') total.unsupportedByKind[kind] = (total.unsupportedByKind[kind] || 0) + value;
    total.naniteProxy ||= !!c.naniteProxy;
    total.downsampled ||= !!c.downsampled;
    total.truncated ||= !!(c.stopReasons || []).some(reason => reason !== 'splat_cap');
    state.nodes[0].sourceCount = (state.nodes[0].sourceCount || 0) + (data.nodes[0]?.sourceCount || 0);
    state.nodes[0].splatCount = (state.nodes[0].splatCount || 0) + (data.nodes[0]?.splatCount || 0);
    state.clusters[0].splatCount += data.clusters[0]?.splatCount || 0;
    state.clusters[0].actorIndices.push(...(data.clusters[0]?.actorIndices || []).map(value => actorBase + value));
    state.clusters[0].nodeIndices.push(...(data.clusters[0]?.nodeIndices || []).map(nodeAt));
    includeBounds(data.boundsCm);
    state.pending = { actorBase, nodeAt, clusterAt, actorCount: data.actors.length,
      nodeCount: data.nodes.length, clusterCount: data.clusters.length };
    if (state.pointSelection) refreshPointScopes();
    awaitScanProgress();
    if (!inspect.hidden) renderInspector();
  };
  window.haybaAppendSplats = function (generation, rows) {
    if (state.done || generation !== state.generation || !Array.isArray(rows) || (gl && !program) || (!gl && !ctx)) return;
    if (state.worldState === 'failed') { state.worldState = 'loading'; updateViewState(); }
    const page = state.pending;
    if (!page) return;
    const valid = rows.slice(0, Math.min(rows.length, MAX_POINTS - state.count)).filter(r => Array.isArray(r) && r.length === 12 && r.every(Number.isFinite) &&
      Number.isSafeInteger(r[ACTOR]) && r[ACTOR] >= 0 && r[ACTOR] < page.actorCount &&
      Number.isSafeInteger(r[NODE]) && r[NODE] >= 0 && r[NODE] < page.nodeCount &&
      Number.isSafeInteger(r[CLUSTER]) && (r[CLUSTER] === -1 || (r[CLUSTER] >= 0 && r[CLUSTER] < page.clusterCount)));
    if (!valid.length) return;
    const data = new Float32Array(valid.length * STRIDE);
    const order = lodOrder(valid.length);
    order.forEach((source, i) => {
      const r = valid[source];
      const color = warmColor(r, false);
      for (let j = 0; j < ROW_FIELDS; j++) data[i * STRIDE + j] = j >= 6 && j <= 8 ? color[j - 6] :
        j === ACTOR ? page.actorBase + r[j] : j === NODE ? page.nodeAt(r[j]) :
          j === CLUSTER ? page.clusterAt(r[j]) : r[j];
    });
    let buffer = null;
    if (gl) { buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); }
    const appended = { buffer, data, count: valid.length, isDepth: false, selectedCount: 0 };
    state.chunks.push(appended); state.count += valid.length;
    awaitScanProgress(); updateViewState();
    if (state.selectionScopes.length || state.selectedIndex >= 0 || state.selectedClusterIndex >= 0 || state.highlightedNodeIndex >= 0)
      updateHighlights(appended);
    else requestDraw();
  };
  window.haybaAppendDepthSplats = function (generation, rows) {
    if (state.done || generation !== state.generation || !Array.isArray(rows) || (gl && !program) || (!gl && !ctx)) return;
    if (state.worldState === 'failed') { state.worldState = 'loading'; updateViewState(); }
    // These rows already carry global actor/node indices. -1 means the depth
    // surface had no trustworthy sparse-ray semantic attribution.
    const valid = rows.slice(0, Math.min(rows.length, MAX_POINTS - state.count)).filter(r =>
      Array.isArray(r) && r.length === ROW_FIELDS && r.every(Number.isFinite) &&
      Number.isSafeInteger(r[ACTOR]) && r[ACTOR] >= -1 && r[ACTOR] < state.actors.length &&
      Number.isSafeInteger(r[NODE]) && r[NODE] >= -1 && r[NODE] < state.nodes.length &&
      r[CLUSTER] === -1);
    if (!valid.length) return;
    // Native depth rows already arrive in a coarse-to-fine order across the
    // whole capture. Reordering each page again collapses far LOD into a region.
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const changed = [];
    for (let cursor = 0; cursor < valid.length;) {
      let chunk = state.chunks[state.chunks.length - 1];
      if (!chunk?.isDepth || chunk.count === DEPTH_CHUNK_POINTS) {
        const capacity = Math.min(DEPTH_CHUNK_POINTS, Math.max(512, valid.length - cursor));
        chunk = { buffer: gl ? gl.createBuffer() : null, data: new Float32Array(capacity * STRIDE),
          capacity, count: 0, isDepth: true, selectedCount: 0 };
        state.chunks.push(chunk);
        if (gl) { gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer); gl.bufferData(gl.ARRAY_BUFFER,
          chunk.data.byteLength, gl.DYNAMIC_DRAW); }
      }
      const take = Math.min(valid.length - cursor, DEPTH_CHUNK_POINTS - chunk.count);
      const required = chunk.count + take;
      if (required > chunk.capacity) {
        const capacity = Math.min(DEPTH_CHUNK_POINTS, Math.max(required, chunk.capacity * 2));
        const grown = new Float32Array(capacity * STRIDE); grown.set(chunk.data.subarray(0, chunk.count * STRIDE));
        chunk.data = grown; chunk.capacity = capacity;
        if (gl) { gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer); gl.bufferData(gl.ARRAY_BUFFER,
          chunk.data.byteLength, gl.DYNAMIC_DRAW); gl.bufferSubData(gl.ARRAY_BUFFER, 0,
          chunk.data.subarray(0, chunk.count * STRIDE)); }
      }
      const start = chunk.count;
      for (let i = 0; i < take; i++) {
        const row = valid[cursor + i], at = (start + i) * STRIDE;
        const color = warmColor(row, true);
        for (let j = 0; j < ROW_FIELDS; j++) chunk.data[at + j] =
          j >= 6 && j <= 8 ? color[j - 6] : row[j];
        for (let axis = 0; axis < 3; axis++) {
          const absolute = row[axis] + state.originCm[axis];
          min[axis] = Math.min(min[axis], absolute); max[axis] = Math.max(max[axis], absolute);
        }
      }
      chunk.count = required; cursor += take;
      if (gl) { gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer); gl.bufferSubData(gl.ARRAY_BUFFER,
        start * STRIDE * 4, chunk.data.subarray(start * STRIDE, required * STRIDE)); }
      changed.push(chunk);
    }
    state.count += valid.length; state.depthPointCount += valid.length;
    includeBounds({ valid: true, min, max });
    awaitScanProgress(); updateViewState();
    if (state.selectionScopes.length || state.selectedIndex >= 0 || state.selectedClusterIndex >= 0 || state.highlightedNodeIndex >= 0)
      for (const chunk of changed) updateHighlights(chunk);
    else requestDraw();
  };
  window.haybaGeometryDone = function (generation, completion) {
    if (generation !== state.generation) return;
    window.clearTimeout(stallTimer);
    state.worldState = completion?.worldState || (completion?.partial || state.coverage.truncated ? 'partial' : 'complete');
    // A level switch invalidates the old observations, including pickable IDs.
    if ((completion?.gaps || []).includes('editor_world_changed')) {
      for (const chunk of state.chunks) releaseChunk(chunk);
      clearTiles();
      state.chunks = []; state.count = state.depthPointCount = 0; state.actors = [];
      state.nodes = []; state.clusters = []; state.worldBounds = null; state.pending = null; state.focusFit = null;
      state.spatialGrid = null;
      state.selectedIndex = state.selectedNodeIndex = state.highlightedNodeIndex = state.selectedClusterIndex = -1;
      state.inspectNode = state.inspectCluster = -1;
      selectedLabel.hidden = true; state.worldState = 'failed'; requestDraw();
      clearScopes();
    }
    state.focusFit = focusFit();
    rebuildSpatialHierarchy();
    if (state.pointSelection) refreshPointScopes();
    if (!state.userMoved) fit();
    state.done = true; state.completion = completion || null; renderInspector();
    if (state.userMoved) scheduleRefinement();
    state.coverage.actorIteratorComplete = state.worldState === 'complete';
    updateViewState();
  };
  window.haybaFit = () => fit('focus');
  window.haybaFitAll = () => fit('all');
  window.haybaGetSelectedWorldEvidence = () => state.selectionEvidence ?
    { ...state.selectionEvidence, positionCm: state.selectionEvidence.positionCm.slice() } : null;
  window.haybaReset = function () {
    state.selectedIndex = -1; state.selectedNodeIndex = -1; state.highlightedNodeIndex = -1; state.selectedClusterIndex = -1;
    state.inspectNode = -1; state.inspectCluster = -1; selectedLabel.hidden = true;
    clearScopes();
    fit('focus'); renderInspector(); updateHighlights();
  };
  document.getElementById('fit').addEventListener('click', e => fit(e.shiftKey ? 'all' : 'focus'));
  exploreButton.addEventListener('click', () => inspect.hidden ? openInspector() : closeInspector());
  document.getElementById('inspect-close').addEventListener('click', closeInspector);
  spatialTab.addEventListener('click', () => { state.inspectMode = 'spatial'; renderInspector(); });
  authoredTab.addEventListener('click', () => {
    state.inspectMode = 'authored';
    if (state.inspectNode < 0 && state.selectedNodeIndex >= 0) state.inspectNode = state.selectedNodeIndex;
    renderInspector();
  });
  document.getElementById('refresh').addEventListener('click', retryScan);
  document.getElementById('scope-prev').addEventListener('click', () => selectScope(state.scopeIndex - 1));
  document.getElementById('scope-next').addEventListener('click', () => selectScope(state.scopeIndex + 1));
  scopeRail.addEventListener('wheel', e => {
    if (!state.selectionScopes.length) return;
    e.preventDefault(); selectScope(state.scopeIndex + Math.sign(e.deltaY));
  }, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    state.drag = { x: e.clientX, y: e.clientY, button: e.button, pan: e.shiftKey || e.button === 2, moved: false };
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', e => {
    if (!state.drag) return;
    const dx = e.clientX - state.drag.x, dy = e.clientY - state.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) { state.drag.moved = true; state.userMoved = true; }
    if (state.drag.pan) {
      const c = camera(), scale = state.distance * 1.3 / Math.max(1, canvas.clientHeight);
      state.target = state.target.map((v, i) => v - c.right[i] * dx * scale + c.up[i] * dy * scale);
    } else { state.yaw -= dx * .006; state.pitch = clamp(state.pitch + dy * .006, -1.5, 1.5); }
    state.drag.x = e.clientX; state.drag.y = e.clientY; requestDraw();
    if (state.drag.moved) scheduleRefinement();
  });
  function pick(e) {
    if (!state.chunks.length && !state.tileChunks.length) return;
    const bounds = canvas.getBoundingClientRect(), x = e.clientX - bounds.left, y = e.clientY - bounds.top;
    const m = viewProjection(bounds.width / Math.max(bounds.height, 1));
    let bestKnown = null, bestUnknown = null;
    const consider = (chunk, i) => {
      const p = i * STRIDE, q = project(chunk.data[p], chunk.data[p + 1], chunk.data[p + 2], m, bounds.width, bounds.height);
      if (!q) return;
      const d = (q.x - x) ** 2 + (q.y - y) ** 2;
      if (d > 11 * 11) return;
      const index = chunk.data[p + ACTOR], nodeIndex = chunk.data[p + NODE], clusterIndex = chunk.data[p + CLUSTER];
      const source = sourceForPoint(chunk, i);
      const known = !!source.actor || !!source.node;
      const previous = known ? bestKnown : bestUnknown;
      if (!previous || q.depth < previous.depth || (q.depth === previous.depth && d < previous.screenDistance)) {
        const candidate = { index, nodeIndex, clusterIndex, depth: q.depth, screenDistance: d,
          chunk, pointIndex: i, isDepth: chunk.isDepth === true, source };
        if (known) bestKnown = candidate; else bestUnknown = candidate;
      }
    };
    if (ctx) forEachCanvasSample(consider);
    else {
      for (const { chunk, count } of visibleRenderPlan(bounds.width, bounds.height))
        for (let i = 0; i < count; i++) consider(chunk, i);
    }
    // A nearby semantic sample can identify the same rendered surface. A
    // much nearer unknown surface remains an occluder, never a guessed actor.
    const knownSurface = !!bestKnown && (!bestUnknown ||
      bestKnown.depth <= bestUnknown.depth + Math.max(30, bestUnknown.depth * .01));
    const best = knownSurface ? bestKnown : bestUnknown;
    if (!best) return;
    const pointAt = best.pointIndex * STRIDE;
    state.selectionEvidence = { generation: state.generation, provenance: best.source.provenance,
      actorPath: best.source.actor?.path || null, nodeId: best.source.node?.id || null,
      tileId: best.source.tileId, pageId: best.source.pageId, rowIndex: best.source.rowIndex,
      captureId: best.isDepth ? state.completion?.depthCapture?.captureId || null : best.source.captureId,
      positionCm: [0, 1, 2].map(axis => best.chunk.data[pointAt + axis] + state.originCm[axis]) };
    if (!knownSurface) {
      // Unknown depth is real geometry, but cannot justify selecting an actor.
      // Show its spatial group without stealing a verified authored selection.
      state.selectedIndex = state.selectedNodeIndex = state.highlightedNodeIndex = -1;
      state.selectedClusterIndex = state.inspectCluster = validIndex(best.clusterIndex, state.clusters) ?
        best.clusterIndex : -1;
      state.inspectNode = -1; state.inspectMode = 'spatial'; selectedLabel.hidden = true;
      state.pointSelection = { chunk: best.chunk, index: best.pointIndex };
      refreshPointScopes();
      if (!inspect.hidden) renderInspector();
      return;
    }
    if (best.chunk.isTile) {
      state.selectedIndex = state.selectedNodeIndex = state.highlightedNodeIndex = -1;
      state.selectedClusterIndex = -1;
      state.inspectNode = -1;
      state.inspectCluster = validIndex(best.clusterIndex, state.clusters) ? best.clusterIndex : -1;
      state.inspectMode = 'spatial';
      state.pointSelection = { chunk: best.chunk, index: best.pointIndex };
      refreshPointScopes();
      if (state.nativeSelection && best.source.actor) {
        state.pendingTileSelect = { tileId: best.chunk.tile.id, pageId: best.source.pageId,
          actorIndex: best.source.actorIndex, actorPath: best.source.actor.path,
          nodeId: best.source.node?.id || null, retries: 0 };
        window.location.href = tileSelectionUrl(state.pendingTileSelect);
      }
      if (!inspect.hidden) renderInspector();
      return;
    }
    state.selectedIndex = best.index; state.selectedNodeIndex = best.nodeIndex;
    state.highlightedNodeIndex = validIndex(best.nodeIndex, state.nodes) ? best.nodeIndex : -1;
    state.selectedClusterIndex = -1;
    state.inspectNode = validIndex(best.nodeIndex, state.nodes) ? best.nodeIndex : -1;
    state.inspectCluster = validIndex(best.clusterIndex, state.clusters) ? best.clusterIndex : -1;
    state.inspectMode = 'authored';
    const actor = state.actors[best.index];
    if (actor && state.nativeSelection && !best.isDepth)
      window.location.href = `hayba-scene-map://select/${state.generation}/${best.index}`;
    state.pointSelection = { chunk: best.chunk, index: best.pointIndex };
    refreshPointScopes();
    if (!inspect.hidden) renderInspector();
  }
  canvas.addEventListener('pointerup', e => {
    if (state.drag && !state.drag.moved && state.drag.button === 0) pick(e);
    state.drag = null; canvas.classList.remove('dragging');
  });
  canvas.addEventListener('pointercancel', () => { state.drag = null; canvas.classList.remove('dragging'); });
  canvas.addEventListener('wheel', e => {
    if (e.altKey && state.selectionScopes.length) {
      e.preventDefault(); selectScope(state.scopeIndex + Math.sign(e.deltaY)); return;
    }
    e.preventDefault(); state.userMoved = true;
    state.distance = clamp(state.distance * Math.exp(e.deltaY * .001), 5, Math.max(100000000, state.radius * 100));
    requestDraw(); scheduleRefinement();
  }, { passive: false });
  canvas.addEventListener('keydown', e => {
    if (e.key === 'f' || e.key === 'F') { fit(e.shiftKey ? 'all' : 'focus'); e.preventDefault(); }
    if (e.key === 'Escape' && !inspect.hidden) { closeInspector(); e.preventDefault(); }
    if (e.key === '+' || e.key === '=') { state.userMoved = true; state.distance = Math.max(5, state.distance * .8); requestDraw(); scheduleRefinement(); e.preventDefault(); }
    if (e.key === '-') { state.userMoved = true; state.distance *= 1.25; requestDraw(); scheduleRefinement(); e.preventDefault(); }
  });
  window.addEventListener('resize', () => { if (state.userMoved) requestDraw(); else fit(); });
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault(); program = null; rendererFailed = true; updateViewState();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    rendererFailed = false; initWebGL();
    // Buffers were lost. Reload to recreate them and request fresh observations.
    clearTiles(); state.worldState = 'failed'; state.chunks = []; state.count = state.depthPointCount = 0;
    updateViewState(); requestDraw();
  });
  if (window.__haybaTest) window.__haybaTest = { state, lodOrder, lodCount, visibleChunkCounts, forEachCanvasSample,
    visibleRenderPlan, visibleTileChunks, desiredTileLod, tileIdAt, residentPointLimit,
    sourceForPoint, tileScopesForPoint, viewProjection, project, scopesForPoint, selectScope };
  initWebGL(); awaitScanProgress(); requestDraw();
})();

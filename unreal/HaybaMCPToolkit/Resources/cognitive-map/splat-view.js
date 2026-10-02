(function () {
  'use strict';
  const canvas = document.getElementById('scene');
  const message = document.getElementById('message');
  const selectedLabel = document.getElementById('selected');
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
  const MAX_POINTS = 131072;
  let gl = null;
  try { gl = canvas.getContext('webgl', { antialias: false, alpha: false }); } catch (_) { /* CEF can disable WebGL. */ }
  let ctx = null;
  if (!gl) try { ctx = canvas.getContext('2d'); } catch (_) { /* Show explicit unavailable state below. */ }
  const state = { generation: null, coverage: null, actors: [], nodes: [], clusters: [], chunks: [], count: 0, done: false, nativeSelection: false,
    pending: null, completion: null,
    originCm: [0, 0, 0], inspectMode: 'spatial', inspectNode: -1, inspectCluster: -1,
    center: [0, 0, 0], radius: 100, target: [0, 0, 0], yaw: -.75, pitch: .36, distance: 300,
    drag: null, userMoved: false, selectedIndex: -1, selectedNodeIndex: -1, highlightedNodeIndex: -1, selectedClusterIndex: -1 };
  let program, attributes, uniforms, framePending = false;

  function showMessage(title, detail) {
    message.replaceChildren();
    const heading = document.createElement('strong'); heading.textContent = title;
    message.append(heading, document.createTextNode(detail || ''));
    message.hidden = false;
  }
  function hideMessage() { message.hidden = true; }
  function finite3(v) { return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite); }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function unit(a) { const l = Math.hypot(...a) || 1; return a.map(x => x / l); }
  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
  function camera() {
    const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
    const eye = [state.target[0] + state.distance * cp * Math.cos(state.yaw), state.target[1] + state.distance * cp * Math.sin(state.yaw), state.target[2] + state.distance * sp];
    const forward = unit(sub(state.target, eye));
    const right = unit(cross(forward, [0, 0, 1]));
    return { eye, forward, right, up: cross(right, forward) };
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
      if (!ctx) showMessage('3D preview unavailable', 'This editor browser cannot draw the world preview.');
      return;
    }
    try {
      const vertex = compile(gl.VERTEX_SHADER, `
        attribute vec3 position; attribute vec3 normal; attribute vec3 color; attribute float highlight;
        uniform mat4 cameraMatrix; uniform float viewportHeight; uniform float pointScale;
        varying vec3 tint; varying float selected;
        void main() {
          vec4 clip = cameraMatrix * vec4(position, 1.0);
          gl_Position = clip;
          gl_PointSize = clamp(pointScale * viewportHeight / max(clip.w, 1.0), 1.5, 22.0);
          vec3 light = normalize(vec3(-0.3, 0.5, 0.85));
          float shade = 0.66 + 0.34 * abs(dot(normalize(normal), light));
          tint = color * shade;
          selected = highlight;
        }`);
      const fragment = compile(gl.FRAGMENT_SHADER, `
        precision mediump float; varying vec3 tint; varying float selected;
        void main() {
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(uv, uv);
          if (r2 > 1.0) discard;
          float alpha = exp(-2.8 * r2);
          vec3 c = mix(tint, vec3(0.769, 0.478, 0.157), selected * 0.7);
          gl_FragColor = vec4(c, alpha);
        }`);
      program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.deleteShader(vertex); gl.deleteShader(fragment);
      attributes = ['position', 'normal', 'color', 'highlight'].map(name => gl.getAttribLocation(program, name));
      uniforms = Object.fromEntries(['cameraMatrix', 'viewportHeight', 'pointScale'].map(name => [name, gl.getUniformLocation(program, name)]));
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } catch (error) {
      program = null;
      showMessage('3D preview unavailable', 'The editor browser could not compile the renderer. ' + String(error.message || error));
    }
  }
  function requestDraw() { if (!framePending) { framePending = true; requestAnimationFrame(draw); } }
  function draw() {
    framePending = false;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio)), height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    if (gl && program) {
      gl.viewport(0, 0, width, height); gl.clearColor(33 / 255, 31 / 255, 29 / 255, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!state.chunks.length) return;
      gl.useProgram(program);
      gl.uniformMatrix4fv(uniforms.cameraMatrix, false, viewProjection(width / height));
      gl.uniform1f(uniforms.viewportHeight, height);
      gl.uniform1f(uniforms.pointScale, Math.max(1, state.radius * .009 * Math.sqrt(4096 / Math.max(4096, state.count))));
      const stride = STRIDE * 4;
      for (const chunk of state.chunks) {
        gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
        [[0, 3, 0], [1, 3, 12], [2, 3, 24], [3, 1, HIGHLIGHT * 4]].forEach(([i, n, offset]) => {
          if (attributes[i] < 0) return;
          gl.enableVertexAttribArray(attributes[i]); gl.vertexAttribPointer(attributes[i], n, gl.FLOAT, false, stride, offset);
        });
        gl.drawArrays(gl.POINTS, 0, lodCount(chunk.count));
      }
    } else if (ctx) {
      ctx.fillStyle = '#211F1D'; ctx.fillRect(0, 0, width, height);
      const m = viewProjection(width / height), points = [];
      const visibleCount = state.chunks.reduce((sum, chunk) => sum + lodCount(chunk.count), 0);
      const step = Math.max(1, Math.ceil(visibleCount / 30000));
      let n = 0;
      for (const chunk of state.chunks) for (let i = 0; i < lodCount(chunk.count); i++, n++) {
        if (n % step) continue;
        const p = i * STRIDE, q = project(chunk.data[p], chunk.data[p + 1], chunk.data[p + 2], m, width, height);
        if (q && q.x >= 0 && q.x < width && q.y >= 0 && q.y < height) points.push({ ...q, data: chunk.data, p });
      }
      points.sort((a, b) => b.depth - a.depth);
      const densityScale = Math.sqrt(4000 / Math.max(4000, state.count));
      for (const q of points) {
        const d = q.data, p = q.p, selected = d[p + HIGHLIGHT] > .5;
        const size = clamp(state.radius * .0085 * height / Math.max(q.depth, 1) * densityScale, 1.2, 2.8);
        const normalShade = Math.abs(d[p + 3] * -.35 + d[p + 4] * .45 + d[p + 5] * .82);
        const minZ = state.worldBounds?.min?.[2] ?? 0, maxZ = state.worldBounds?.max?.[2] ?? 1;
        const elevation = clamp((d[p + 2] + state.originCm[2] - minZ) / Math.max(maxZ - minZ, 1), 0, 1);
        const shade = .76 + .22 * normalShade + .12 * elevation;
        ctx.fillStyle = selected ? '#C47429' : `rgb(${Math.min(255, Math.round(d[p + 6] * 255 * shade))},${Math.min(255, Math.round(d[p + 7] * 255 * shade))},${Math.min(255, Math.round(d[p + 8] * 255 * shade))})`;
        ctx.globalAlpha = selected ? .98 : .86;
        ctx.beginPath(); ctx.arc(q.x, q.y, size, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
  function lodCount(count) {
    if (state.count < 20000) return count;
    const ratio = state.distance / Math.max(state.radius, 1);
    const fraction = ratio > 4 ? .25 : ratio > 2 ? .5 : 1;
    return Math.max(1, Math.ceil(count * fraction));
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
  function fit() {
    state.userMoved = false;
    state.target = state.center.slice(); state.yaw = -.75; state.pitch = .36;
    state.distance = Math.max(150, state.radius * 2.25); requestDraw();
  }
  function validIndex(index, list) { return Number.isSafeInteger(index) && index >= 0 && index < list.length; }
  function descendants(list, parent) {
    const matches = new Set();
    if (!validIndex(parent, list)) return matches;
    const children = new Map();
    list.forEach((item, index) => {
      const at = item.parentIndex;
      if (validIndex(at, list)) {
        if (!children.has(at)) children.set(at, []);
        children.get(at).push(index);
      }
    });
    const queue = [parent];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const at = queue[cursor];
      if (matches.has(at)) continue;
      matches.add(at);
      for (const child of children.get(at) || []) queue.push(child);
    }
    return matches;
  }
  function updateHighlights() {
    const nodeMatches = descendants(state.nodes, state.highlightedNodeIndex);
    const clusterMatches = descendants(state.clusters, state.selectedClusterIndex);
    for (const chunk of state.chunks) {
      for (let i = 0; i < chunk.count; i++) {
        const p = i * STRIDE;
        const selected = state.highlightedNodeIndex >= 0 ? nodeMatches.has(chunk.data[p + NODE]) :
          state.selectedIndex >= 0 ? chunk.data[p + ACTOR] === state.selectedIndex :
          state.selectedClusterIndex >= 0 && clusterMatches.has(chunk.data[p + CLUSTER]);
        chunk.data[p + HIGHLIGHT] = selected ? 1 : 0;
      }
      if (gl && program && chunk.buffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, chunk.data, gl.DYNAMIC_DRAW);
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
    while (validIndex(index, list) && !seen.has(index)) {
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
    state.distance = Math.max(100, Math.hypot(...span) * 1.4); requestDraw();
  }
  function visitCluster(index) {
    state.inspectCluster = validIndex(index, state.clusters) ? index : -1;
    state.selectedClusterIndex = state.inspectCluster;
    state.selectedIndex = -1; state.highlightedNodeIndex = -1;
    if (state.inspectCluster >= 0) selectedLabel.textContent = clusterLabel(state.inspectCluster);
    if (state.inspectCluster >= 0) focusBounds(state.clusters[state.inspectCluster].boundsCm);
    else fit();
    renderInspector(); updateHighlights();
  }
  function visitNode(index) {
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
    selectedLabel.hidden = state.selectedIndex < 0 && state.highlightedNodeIndex < 0 && state.selectedClusterIndex < 0;
  }
  function renderInspector() {
    if (inspect.hidden) return;
    const spatial = state.inspectMode === 'spatial';
    spatialTab.setAttribute('aria-selected', String(spatial));
    authoredTab.setAttribute('aria-selected', String(!spatial));
    inspectTrail.replaceChildren(); inspectBody.replaceChildren();
    inspectSubtitle.textContent = spatial ? 'Derived from mesh sample positions' : 'Observed in the editor';
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
        addFact(facts, `${group.splatCount || 0} samples`);
        addFact(facts, `${Array.isArray(group.actorIndices) ? group.actorIndices.length : 0} actors`);
        for (const tag of (Array.isArray(group.tags) ? group.tags : []).slice(0, 3)) addFact(facts, `Source tag: ${tag}`);
        if (group.tagsTruncated) addFact(facts, 'More source tags omitted');
      } else {
        addFact(facts, `${state.count} mesh samples`);
        addFact(facts, 'Loaded static meshes only');
      }
      inspectBody.append(facts);
      const children = state.clusters.map((c, i) => c.parentIndex === index ? i : -1).filter(i => i >= 0 && state.clusters[i].splatCount > 0);
      addSection('Spatial groups', children, clusterLabel,
        i => `${state.clusters[i].splatCount} samples`, visitCluster);
      if (group && !children.length) {
        const sources = [...new Set(Array.isArray(group.nodeIndices) ? group.nodeIndices : [])]
          .filter(i => validIndex(i, state.nodes));
        addSection('Authored sources here', sources, i => labelOf(state.nodes[i], 'Source'),
          i => nodeKind(state.nodes[i].kind), i => { state.inspectMode = 'authored'; visitNode(i); });
      }
      if (!group && !children.length) {
        const empty = document.createElement('div'); empty.className = 'inspect-empty';
        empty.textContent = state.done ? 'No spatial groups from loaded mesh surfaces.' : 'Scanning loaded mesh surfaces…';
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
    if (!data || !Number.isSafeInteger(data.generation) || !finite3(data.originCm)) return;
    for (const chunk of state.chunks) if (gl && chunk.buffer) gl.deleteBuffer(chunk.buffer);
    state.generation = data.generation; state.coverage = data.coverage || {}; state.actors = [];
    state.coverage.actorIteratorComplete = true;
    state.coverage.truncated = false;
    state.coverage.unsupportedByKind ||= {};
    state.worldBounds = null;
    state.nodes = [{ id: 'loaded-world', parentIndex: -1, kind: 'world', label: 'Loaded world', actorIndex: -1, boundsCm: { valid: false } }];
    state.clusters = [{ id: 'spatial:loaded-world', parentIndex: -1, level: 0, splatCount: 0,
      actorIndices: [], nodeIndices: [], boundsCm: { valid: false }, tags: [] }];
    state.pending = null; state.completion = null;
    state.originCm = data.originCm;
    state.nativeSelection = data.nativeSelection === true; state.chunks = []; state.count = 0; state.done = false;
    state.userMoved = false;
    state.selectedIndex = -1; state.selectedNodeIndex = -1; state.highlightedNodeIndex = -1; state.selectedClusterIndex = -1;
    state.inspectNode = -1; state.inspectCluster = -1;
    selectedLabel.hidden = true;
    const bounds = data.boundsCm;
    if (bounds && bounds.valid !== false && finite3(bounds.min) && finite3(bounds.max)) {
      state.center = bounds.min.map((v, i) => (v + bounds.max[i]) / 2 - data.originCm[i]);
      state.radius = Math.max(1, Math.hypot(...bounds.max.map((v, i) => v - bounds.min[i])) / 2);
    } else { state.center = [0, 0, 0]; state.radius = 100; }
    fit(); renderInspector();
    if ((gl && !program) || (!gl && !ctx)) return;
    showMessage('Sampling loaded meshes', 'The 3D preview will appear as the editor sends surface samples.');
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
      actorIndices: [], nodeIndices: [], tags: [], splatCount: 0, centroidCm: [0, 0, 0] };
    const clusters = [root], coarse = new Map(), fine = new Map(), members = [
      { actors: new Set(), nodes: new Set(), tags: new Set() }];
    const span = world.max.map((v, i) => Math.max(v - world.min[i], 1));
    function axis(value, min, extent, cells) {
      return Math.max(0, Math.min(cells - 1, Math.floor(cells * (value - min) / extent)));
    }
    function ensure(map, key, parentIndex, level) {
      if (map.has(key)) return map.get(key);
      const index = clusters.length;
      map.set(key, index);
      clusters.push({ id: `spatial:${level}:${key}`, parentIndex, level,
        boundsCm: { valid: false }, actorIndices: [], nodeIndices: [], tags: [],
        splatCount: 0, centroidCm: [0, 0, 0] });
      members.push({ actors: new Set(), nodes: new Set(), tags: new Set() });
      return index;
    }
    for (const chunk of state.chunks) for (let i = 0; i < chunk.count; i++) {
      const p = i * STRIDE, data = chunk.data;
      const point = [0, 1, 2].map(axisIndex => data[p + axisIndex] + state.originCm[axisIndex]);
      const x = axis(point[0], world.min[0], span[0], 8);
      const y = axis(point[1], world.min[1], span[1], 8);
      const z = axis(point[2], world.min[2], span[2], 4);
      const coarseKey = `${x >> 1}:${y >> 1}:${z >> 1}`;
      const coarseIndex = ensure(coarse, coarseKey, 0, 1);
      const fineIndex = ensure(fine, `${x}:${y}:${z}`, coarseIndex, 2);
      data[p + CLUSTER] = fineIndex;
      for (const index of [0, coarseIndex, fineIndex]) {
        const cluster = clusters[index], member = members[index];
        cluster.splatCount++;
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
    state.inspectCluster = state.selectedClusterIndex = -1;
    if (gl && program) for (const chunk of state.chunks) {
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, chunk.data, gl.DYNAMIC_DRAW);
    }
    requestDraw();
  }
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
    if (generation !== state.generation || !data || !Array.isArray(data.actors) || !Array.isArray(data.nodes) || !Array.isArray(data.clusters)) return;
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
    if (!inspect.hidden) renderInspector();
  };
  window.haybaAppendSplats = function (generation, rows) {
    if (generation !== state.generation || !Array.isArray(rows) || (gl && !program) || (!gl && !ctx)) return;
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
      for (let j = 0; j < ROW_FIELDS; j++) data[i * STRIDE + j] = j >= 6 && j <= 8 ? clamp(r[j] / 255, 0, 1) :
        j === ACTOR ? page.actorBase + r[j] : j === NODE ? page.nodeAt(r[j]) :
          j === CLUSTER ? page.clusterAt(r[j]) : r[j];
    });
    let buffer = null;
    if (gl) { buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); }
    state.chunks.push({ buffer, data, count: valid.length }); state.count += valid.length;
    hideMessage(); updateHighlights();
  };
  window.haybaGeometryDone = function (generation, completion) {
    if (generation !== state.generation) return;
    rebuildSpatialHierarchy();
    if (!state.userMoved) fit();
    state.done = true; state.completion = completion || null; renderInspector();
    if (!state.count && (program || ctx)) showMessage('No mesh surfaces in this scan', 'Load a level with supported static mesh components, then refresh. Empty space is not inferred.');
  };
  window.haybaFit = fit;
  window.haybaReset = function () {
    state.selectedIndex = -1; state.selectedNodeIndex = -1; state.highlightedNodeIndex = -1; state.selectedClusterIndex = -1;
    state.inspectNode = -1; state.inspectCluster = -1; selectedLabel.hidden = true;
    fit(); renderInspector(); updateHighlights();
  };
  document.getElementById('fit').addEventListener('click', fit);
  exploreButton.addEventListener('click', () => inspect.hidden ? openInspector() : closeInspector());
  document.getElementById('inspect-close').addEventListener('click', closeInspector);
  spatialTab.addEventListener('click', () => { state.inspectMode = 'spatial'; renderInspector(); });
  authoredTab.addEventListener('click', () => {
    state.inspectMode = 'authored';
    if (state.inspectNode < 0 && state.selectedNodeIndex >= 0) state.inspectNode = state.selectedNodeIndex;
    renderInspector();
  });
  document.getElementById('refresh').addEventListener('click', () => { if (state.generation !== null) window.location.href = `hayba-scene-map://refresh/${state.generation}`; });
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
  });
  function pick(e) {
    if (!state.chunks.length) return;
    const bounds = canvas.getBoundingClientRect(), x = e.clientX - bounds.left, y = e.clientY - bounds.top;
    const m = viewProjection(bounds.width / Math.max(bounds.height, 1));
    let best = null;
    for (const chunk of state.chunks) for (let i = 0; i < lodCount(chunk.count); i++) {
      const p = i * STRIDE, q = project(chunk.data[p], chunk.data[p + 1], chunk.data[p + 2], m, bounds.width, bounds.height);
      if (!q) continue;
      const d = (q.x - x) ** 2 + (q.y - y) ** 2;
      if (d <= 11 * 11 && (!best || q.depth < best.depth || (q.depth === best.depth && d < best.screenDistance)))
        best = { index: chunk.data[p + ACTOR], nodeIndex: chunk.data[p + NODE],
          clusterIndex: chunk.data[p + CLUSTER], depth: q.depth, screenDistance: d };
    }
    if (!best) return;
    state.selectedIndex = best.index; state.selectedNodeIndex = best.nodeIndex;
    state.highlightedNodeIndex = validIndex(best.nodeIndex, state.nodes) ? best.nodeIndex : -1;
    state.selectedClusterIndex = -1;
    state.inspectNode = validIndex(best.nodeIndex, state.nodes) ? best.nodeIndex : -1;
    state.inspectCluster = validIndex(best.clusterIndex, state.clusters) ? best.clusterIndex : -1;
    state.inspectMode = 'authored';
    const actor = state.actors[best.index];
    if (actor) {
      selectedLabel.textContent = actor.label || actor.path || 'Selected actor'; selectedLabel.hidden = false;
      if (state.nativeSelection) window.location.href = `hayba-scene-map://select/${state.generation}/${best.index}`;
    }
    openInspector('authored');
    updateHighlights();
  }
  canvas.addEventListener('pointerup', e => {
    if (state.drag && !state.drag.moved && state.drag.button === 0) pick(e);
    state.drag = null; canvas.classList.remove('dragging');
  });
  canvas.addEventListener('pointercancel', () => { state.drag = null; canvas.classList.remove('dragging'); });
  canvas.addEventListener('wheel', e => {
    e.preventDefault(); state.userMoved = true;
    state.distance = clamp(state.distance * Math.exp(e.deltaY * .001), 5, Math.max(100000000, state.radius * 100)); requestDraw();
  }, { passive: false });
  canvas.addEventListener('keydown', e => {
    if (e.key === 'f' || e.key === 'F') { fit(); e.preventDefault(); }
    if (e.key === 'Escape' && !inspect.hidden) { closeInspector(); e.preventDefault(); }
    if (e.key === '+' || e.key === '=') { state.userMoved = true; state.distance = Math.max(5, state.distance * .8); requestDraw(); e.preventDefault(); }
    if (e.key === '-') { state.userMoved = true; state.distance *= 1.25; requestDraw(); e.preventDefault(); }
  });
  window.addEventListener('resize', requestDraw);
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); program = null; showMessage('3D preview paused', 'The editor browser lost its WebGL context. Refresh the world preview.'); });
  canvas.addEventListener('webglcontextrestored', () => { initWebGL(); state.chunks = []; state.count = 0; showMessage('3D preview reset', 'Refresh to send mesh samples again.'); requestDraw(); });
  if (window.__haybaTest) window.__haybaTest = { state, lodOrder, lodCount };
  initWebGL(); requestDraw();
})();

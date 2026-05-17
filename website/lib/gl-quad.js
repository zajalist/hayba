// Minimal full-screen-quad WebGL mounter.
// All the boilerplate every Hayba background shader needs in one place:
//   - get a webgl context (or hide the canvas and bail)
//   - compile + link a vertex + fragment shader
//   - allocate a static full-screen quad
//   - DPR-aware resize via ResizeObserver
//   - requestAnimationFrame loop
//   - prefers-reduced-motion freeze
//
// Caller writes a fragment shader (string), gives a per-frame `onFrame` that
// sets uniforms, gets back a handle with `stop()`.

const VS = `attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FULL_SCREEN_QUAD = new Float32Array([
  -1, -1,  1, -1,  -1, 1,
  -1,  1,  1, -1,   1, 1,
]);

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {string} opts.fragmentShader  GLSL source.
 * @param {(api: { gl: WebGLRenderingContext, time: number, width: number, height: number, aspect: number, uniform: (name:string) => WebGLUniformLocation | null }) => void} opts.onFrame
 *   Called every animation frame; set uniforms here, then draw is invoked.
 * @returns {{ stop(): void } | null}  Null if WebGL is unavailable.
 */
export function mountQuad(canvas, { fragmentShader, onFrame }) {
  const gl = canvas.getContext('webgl', {
    antialias: false,
    depth: false,
    premultipliedAlpha: false,
    alpha: true,
  });
  if (!gl) { canvas.style.display = 'none'; return null; }

  const prog = compileLink(gl, VS, fragmentShader);
  if (!prog) return null;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, FULL_SCREEN_QUAD, gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  const uniformCache = new Map();
  function uniform(name) {
    if (!uniformCache.has(name)) {
      uniformCache.set(name, gl.getUniformLocation(prog, name));
    }
    return uniformCache.get(name);
  }

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(2, Math.round(r.width * dpr));
    canvas.height = Math.max(2, Math.round(r.height * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  window.addEventListener('resize', resize);
  let resizeObs = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObs = new ResizeObserver(resize);
    resizeObs.observe(canvas.parentElement);
  }

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const start = performance.now();
  let raf = 0;
  let stopped = false;

  function frame(now) {
    if (stopped) return;
    const time = reduce.matches ? 0 : (now - start) / 1000;
    onFrame({
      gl,
      time,
      width: canvas.width,
      height: canvas.height,
      aspect: canvas.width / canvas.height,
      uniform,
    });
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      resizeObs?.disconnect();
    },
  };
}

function compileLink(gl, vsrc, fsrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('gl-quad link error:', gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('gl-quad compile error:', gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

// Raw-WebGL2 offscreen pass runner — bypasses three.js's WebGLRenderer for
// the ~1000 manual bake passes so a WebGL feedback loop is STRUCTURALLY
// impossible.
//
// WHY THIS EXISTS
// ---------------
// The GPU bake issues ~1000 hand-orchestrated fullscreen passes (ping-pong
// + explicit src/dst accumulations). Driving these through three's
// `WebGLRenderer.render()` leaks texture-unit GL state across our manual
// passes: three keeps a JS-side `currentBoundTextures` cache and SKIPS
// `gl.bindTexture` when it believes a texture is already on a unit. A
// texture bound to a high unit by an earlier pass survives physically, and
// when a later pass binds that very RT as its draw-FBO color attachment
// Chrome/ANGLE flags "Feedback loop formed between Framebuffer and active
// Texture" and DISCARDS every draw → the erosion field degenerates.
// Instrumentation proved the erosion code is correct (SELF-ALIAS and
// GL-ALIAS both negative — no uniform self-alias); the defect is purely
// three's renderer leaking GL state across our manual passes.
//
// This module runs each pass on the raw `WebGL2RenderingContext` with its
// OWN single FBO, OWN VAO + fullscreen-triangle VBO, and — critically — an
// EXPLICIT post-draw unbind of every sampler unit it bound + the FBO. The
// destination RT is only ever an FBO color attachment, never a sampler
// (GL-ALIAS proved no uniform == dst). After each pass all sampler units
// are null and the FBO is unbound, so read==write at the GL level cannot
// occur: the feedback loop is structurally impossible, not merely avoided.
//
// THREE-EQUIVALENT PROGRAM
// ------------------------
// The bake frags are compiled by three as `new THREE.ShaderMaterial({
// glslVersion: THREE.GLSL3, ... })`. We reproduce the SAME effective
// program three would have linked. Verified against
// node_modules/three/build/three.module.js r0.169:
//
//  • versionString — three.module.js:20187 forces `'#version 300 es\n'`
//    for any non-RawShaderMaterial (ShaderMaterial included). We prepend
//    the identical line.
//  • precision — three.module.js:19648 generatePrecision() injects
//    `precision highp float; precision highp int; ...` (highp is the
//    desktop WebGL2 default). The bake GLSL_PREAMBLE (passes.glsl.ts:67)
//    ALREADY declares its own `precision highp float;` +
//    `precision highp int;` + `out vec4 fragColor;`, so the frags are
//    fully self-contained: three's precision/out plumbing is redundant
//    for them. We still emit a leading `precision highp float;` +
//    `precision highp int;` (harmless redeclaration is legal in GLSL ES
//    3.00 and matches three's effective state) before the frag string.
//  • fragment out — the frags declare `out vec4 fragColor;` themselves
//    (passes.glsl.ts:70; three's GLSL3 path does NOT auto-name an out,
//    three.module.js:20198-20199 emit nothing for GLSL3). We add nothing.
//  • vertex — three's ShaderMaterial prefix injects `attribute vec3
//    position;` then `#define attribute in` (three.module.js:20009 +
//    20191). The bake VS is `void main(){ gl_Position =
//    vec4(position.xy,0.0,1.0); }`. We supply an equivalent standalone
//    GLSL3 VS that itself declares `in vec3 position;` (no three
//    built-ins — modelMatrix/viewMatrix/uv/normal are unreferenced by
//    the bake shaders, verified by source inspection).
//
// The standalone program is therefore byte-equivalent in behavior to what
// three would have compiled for these self-contained compute frags.
//
// UNIFORM TYPING
// --------------
// Getting an int/uint uniform wrong silently corrupts the bake. Rather
// than a fragile name table, we PARSE each frag's own `uniform <type>
// <name>;` declarations (every bake frag is self-contained and declares
// every uniform it uses). The resolved GLSL type drives the setter:
//   float       → uniform1f          (number)
//   int         → uniform1i          (number; uManualBilinear/uLevel/
//                                      uUpsampleMode)
//   vec2        → uniform2f          (THREE.Vector2)
//   vec3        → uniform3f          (THREE.Vector3)
//   uvec2       → uniform2ui         (THREE.Vector2 of uint bit-patterns;
//                                      uSeed — the u64 hash seed lo/hi)
//   sampler2D   → bind to a unit + uniform1i
// Verified declarations (passes.glsl.ts / erodePipeline.ts helper frags):
//   uFaceRes float:77, uManualBilinear int:377, uSeed uvec2:643,
//   uLevel int:644, uUpsampleMode int:854 — all others float/vec2/sampler.

import * as THREE from "three";

/* Standalone GLSL3 fullscreen-triangle vertex shader. A 3-vertex
 * oversized triangle covers the whole viewport; gl_FragCoord is
 * identical to a 2-triangle quad, so the existing
 * `gl_FragCoord.xy / uResolution` decode in every frag is unaffected.
 * Declares its own `in vec3 position;` (three's prefix would have
 * injected `attribute vec3 position;` + `#define attribute in`). */
const STANDALONE_VS =
  "#version 300 es\n" +
  "in vec3 position;\n" +
  "void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }\n";

/* The three-equivalent GLSL3 fragment prefix. `#version 300 es` matches
 * three.module.js:20187 (forced for ShaderMaterial). The two precision
 * lines match generatePrecision()'s effective highp state
 * (three.module.js:19648) AND the frag's own GLSL_PREAMBLE
 * (passes.glsl.ts:68-69) — a redeclaration that is legal in GLSL ES 3.00
 * and keeps the standalone program behavior-identical. The frag string
 * itself declares `out vec4 fragColor;` and uses `texture()` (native
 * GLSL3), so nothing else is needed. */
function buildFragmentSource(frag: string): string {
  return (
    "#version 300 es\n" +
    "precision highp float;\n" +
    "precision highp int;\n" +
    frag
  );
}

function buildVertexSource(vert: string): string {
  return (
    "#version 300 es\n" +
    "precision highp float;\n" +
    "precision highp int;\n" +
    vert
  );
}

type Gl = WebGL2RenderingContext;

/** Per-program compiled+linked state + caches. */
interface ProgramEntry {
  program: WebGLProgram;
  /** uniform name → location (null if optimized out). */
  loc: Map<string, WebGLUniformLocation | null>;
  /** uniform name → parsed GLSL base type. */
  type: Map<string, UniformGlType>;
}

type UniformGlType =
  | "float"
  | "int"
  | "uint"
  | "vec2"
  | "vec3"
  | "vec4"
  | "uvec2"
  | "ivec2"
  | "sampler2D"
  | "unknown";

/* Lazily-initialised module-level GL resources. Lazy so the headless bake
 * tests (fake renderer with only getContext for the extension probe) never
 * touch a real GL context — the tests never call runRawPass. */
let _gl: Gl | null = null;
let _fbo: WebGLFramebuffer | null = null;
let _vao: WebGLVertexArrayObject | null = null;
let _pointVao: WebGLVertexArrayObject | null = null;
let _vbo: WebGLBuffer | null = null;
const _programs = new Map<string, ProgramEntry>();
/* Resolved GL texture handle per three Texture/RT, keyed by the three
 * object so it is resolved once (three's WebGLProperties is stable once
 * the RT/texture is GL-allocated; we reuse three's same GL texture object
 * so its float/filter/wrap params persist — we never re-set them). */
const _glTexCache = new WeakMap<object, WebGLTexture>();

/** Parse `uniform <qual?> <type> <name> [= ...] ;` decls from a frag. */
function parseUniformTypes(src: string): Map<string, UniformGlType> {
  const out = new Map<string, UniformGlType>();
  // Matches: uniform [highp|mediump|lowp] <type> <name> ( [N] )? ;
  // Bake frags declare one uniform per statement (verified). The optional
  // precision qualifier is tolerated though the bake frags don't use it
  // on uniforms.
  const re =
    /\buniform\s+(?:(?:highp|mediump|lowp)\s+)?([A-Za-z_][\w]*)\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const glslType = m[1];
    const name = m[2];
    let t: UniformGlType;
    switch (glslType) {
      case "float":
        t = "float";
        break;
      case "int":
        t = "int";
        break;
      case "uint":
        t = "uint";
        break;
      case "vec2":
        t = "vec2";
        break;
      case "vec3":
        t = "vec3";
        break;
      case "vec4":
        t = "vec4";
        break;
      case "uvec2":
        t = "uvec2";
        break;
      case "ivec2":
        t = "ivec2";
        break;
      case "sampler2D":
        t = "sampler2D";
        break;
      default:
        t = "unknown";
        break;
    }
    out.set(name, t);
  }
  return out;
}

/** Test-only re-export. Do not depend on this from production code. */
export const __parseUniformTypesForTest = parseUniformTypes;

function compileShader(
  gl: Gl,
  kind: number,
  source: string,
  label: string,
): WebGLShader {
  const sh = gl.createShader(kind);
  if (!sh) throw new Error(`glPass: createShader failed (${label})`);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(
      `glPass: ${label} shader compile failed:\n${log ?? "(no log)"}`,
    );
  }
  return sh;
}

/** Ensure the module-level GL resources exist (lazy, once). */
function ensureGl(renderer: THREE.WebGLRenderer): Gl {
  if (_gl) return _gl;
  // three r0.169 is WebGL2-only; getContext() returns a real
  // WebGL2RenderingContext at bake time.
  const gl = renderer.getContext() as WebGL2RenderingContext;
  _gl = gl;

  _fbo = gl.createFramebuffer();
  if (!_fbo) throw new Error("glPass: createFramebuffer failed");

  // Fullscreen oversized triangle (3 verts, clip-space). Covers the whole
  // viewport; gl_FragCoord identical to a 2-triangle quad.
  _vao = gl.createVertexArray();
  _vbo = gl.createBuffer();
  if (!_vao || !_vbo) throw new Error("glPass: createVAO/VBO failed");
  gl.bindVertexArray(_vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, _vbo);
  // (-1,-1) (3,-1) (-1,3) — clip space; covers [-1,1]^2.
  const verts = new Float32Array([
    -1, -1, 0, 3, -1, 0, -1, 3, 0,
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  return gl;
}

/** Compile+link (once) and cache the program for a fragment source. */
function ensureProgram(gl: Gl, frag: string): ProgramEntry {
  let entry = _programs.get(frag);
  if (entry) return entry;

  const vs = compileShader(gl, gl.VERTEX_SHADER, STANDALONE_VS, "vertex");
  const fsSrc = buildFragmentSource(frag);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, "fragment");

  const program = gl.createProgram();
  if (!program) throw new Error("glPass: createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  // Bind the VS `position` attribute to location 0 (matches the VAO).
  gl.bindAttribLocation(program, 0, "position");
  gl.linkProgram(program);
  // Shaders can be detached/deleted after a successful link.
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    // Loud — a shader-prefix mismatch must NOT be silent. Name the frag
    // by its first signature-ish token so the failing pass is clear.
    const idMatch = frag.match(/[A-Za-z_]\w*\s*\(/);
    const fid = idMatch ? idMatch[0].replace(/\s+/g, "") : frag.slice(0, 32);
    throw new Error(
      `glPass: program link failed for frag "${fid}":\n${log ?? "(no log)"}`,
    );
  }

  entry = {
    program,
    loc: new Map(),
    type: parseUniformTypes(frag),
  };
  _programs.set(frag, entry);
  return entry;
}

/** Compile+link (once) and cache the program for a vertex+fragment source pair. */
function ensureProgramVF(gl: Gl, vert: string, frag: string): ProgramEntry {
  const key = "P|" + vert + "\n" + frag;
  let entry = _programs.get(key);
  if (entry) return entry;

  const vs = compileShader(gl, gl.VERTEX_SHADER, buildVertexSource(vert), "vertex");
  const fsSrc = buildFragmentSource(frag);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, "fragment");

  const program = gl.createProgram();
  if (!program) throw new Error("glPass: createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  // Bind the VS `position` attribute to location 0 (matches the VAO).
  gl.bindAttribLocation(program, 0, "position");
  gl.linkProgram(program);
  // Shaders can be detached/deleted after a successful link.
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    // Loud — a shader-prefix mismatch must NOT be silent. Name the frag
    // by its first signature-ish token so the failing pass is clear.
    const idMatch = frag.match(/[A-Za-z_]\w*\s*\(/);
    const fid = idMatch ? idMatch[0].replace(/\s+/g, "") : frag.slice(0, 32);
    throw new Error(
      `glPass: program link failed for frag "${fid}":\n${log ?? "(no log)"}`,
    );
  }

  entry = {
    program,
    loc: new Map(),
    type: parseUniformTypes(vert + "\n" + frag),
  };
  _programs.set(key, entry);
  return entry;
}

function uniformLoc(
  gl: Gl,
  entry: ProgramEntry,
  name: string,
): WebGLUniformLocation | null {
  if (entry.loc.has(name)) return entry.loc.get(name) ?? null;
  const loc = gl.getUniformLocation(entry.program, name);
  entry.loc.set(name, loc);
  return loc;
}

/** Force three to GL-allocate a RT (texture + framebuffer) once. */
function resolveRtGlTexture(
  renderer: THREE.WebGLRenderer,
  rt: THREE.WebGLRenderTarget,
): WebGLTexture {
  const cached = _glTexCache.get(rt);
  if (cached) return cached;
  // three r0.169 public API (three.module.js:31503): ensures
  // properties.get(rt).__webglFramebuffer + __webglTexture exist via
  // textures.setupRenderTarget(rt) — idempotent (no-op if already set).
  renderer.initRenderTarget(rt);
  const props = renderer.properties.get(rt.texture) as
    | { __webglTexture?: WebGLTexture }
    | undefined;
  const tex = props?.__webglTexture;
  if (!tex) {
    throw new Error(
      "glPass: RT __webglTexture unresolved after initRenderTarget",
    );
  }
  _glTexCache.set(rt, tex);
  return tex;
}

/** Force three to GL-upload a Texture/DataTexture once; resolve its
 * GL handle. Reusing three's own GL texture object means the float/
 * filter/wrap params three already set persist — we never re-set them. */
function resolveTexGlHandle(
  renderer: THREE.WebGLRenderer,
  tex: THREE.Texture,
): WebGLTexture {
  const cached = _glTexCache.get(tex);
  if (cached) return cached;
  // three r0.169 public API (three.module.js:31513): textures.setTexture2D
  // — uploads + sets params, allocates __webglTexture. Idempotent.
  renderer.initTexture(tex);
  const props = renderer.properties.get(tex) as
    | { __webglTexture?: WebGLTexture }
    | undefined;
  const handle = props?.__webglTexture;
  if (!handle) {
    throw new Error("glPass: texture __webglTexture unresolved");
  }
  _glTexCache.set(tex, handle);
  return handle;
}

/** Is a uniform value a three RenderTarget? */
function asRenderTarget(v: unknown): THREE.WebGLRenderTarget | null {
  if (
    v != null &&
    (v as { isWebGLRenderTarget?: boolean }).isWebGLRenderTarget === true
  ) {
    return v as THREE.WebGLRenderTarget;
  }
  return null;
}

/**
 * Run ONE fullscreen fragment-shader pass on the raw WebGL2 context into
 * `dstRT`, with explicit per-pass GL-state hygiene. This is the whole
 * point: nothing three does to its GL-state cache can affect this draw,
 * and every sampler unit + the FBO is explicitly unbound afterwards, so a
 * read==write feedback loop is structurally impossible.
 */
export function runRawPass(
  renderer: THREE.WebGLRenderer,
  frag: string,
  uniforms: Record<string, THREE.IUniform>,
  dstRT: THREE.WebGLRenderTarget,
): void {
  const gl = ensureGl(renderer);
  const entry = ensureProgram(gl, frag);
  const fbo = _fbo as WebGLFramebuffer;
  const vao = _vao as WebGLVertexArrayObject;

  const dstGlTex = resolveRtGlTexture(renderer, dstRT);

  // 1-2. Bind our own FBO and (re)attach the dst's GL texture each pass.
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    dstGlTex,
    0,
  );

  // 3. (dev-gated) framebuffer completeness assert — a misconfigured
  // attachment should be loud, not a silently black pass.
  if (
    (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true
  ) {
    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(
        `glPass: framebuffer incomplete (0x${fbStatus.toString(16)})`,
      );
    }
  }

  // 4. Fixed-function state for an offscreen compute pass.
  gl.viewport(0, 0, dstRT.width, dstRT.height);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.CULL_FACE);
  gl.colorMask(true, true, true, true);

  // 5. Program + geometry.
  gl.useProgram(entry.program);
  gl.bindVertexArray(vao);

  // 6. Upload uniforms by parsed GLSL type. Track sampler units bound so
  //    they can be explicitly unbound after the draw.
  //
  // SAMPLERS ARE TWO-PHASE (load-bearing — do NOT inline phase 2 into
  // phase 1). resolveRtGlTexture/resolveTexGlHandle call three's
  // renderer.initRenderTarget / renderer.initTexture, which on a
  // texture/RT's FIRST use run textures.setupRenderTarget /
  // textures.setTexture2D. Those go through three's WebGLState and issue
  // REAL gl.activeTexture(TEXTURE0+slot)/gl.bindTexture (slot defaults to
  // 0) plus a state.texImage2D upload. If we resolved+raw-bound samplers
  // one-by-one, the resolve of sampler N (e.g. uPrecip, a DataTexture's
  // first upload) would clobber the raw bind we already did for sampler
  // N-1 on its unit (e.g. uA on unit 0) — three's setTexture2D rebinds
  // unit 0. The shader then samples the wrong texture for the earlier unit
  // (uA reads zeros while only the later sampler is correct → the exact
  // "terrain/ocean collapse, water-only updates" failure). So: PHASE 1
  // resolves EVERY sampler handle (all three-state touches happen here,
  // before any raw unit bind); PHASE 2 raw-binds the resolved handles to
  // units with NO three call interleaved, so nothing can clobber a unit
  // after it is bound.
  let unit = 0;
  const boundUnits: number[] = [];
  // Phase 1: resolve all sampler GL handles + assign units (three's lazy
  // init/upload may bind textures on its own units here — harmless now,
  // because no raw unit binds have happened yet).
  const samplerBinds: {
    loc: WebGLUniformLocation;
    handle: WebGLTexture;
    unit: number;
  }[] = [];
  for (const name of Object.keys(uniforms)) {
    const u = uniforms[name];
    if (!u) continue;
    const value = u.value as unknown;
    const loc = uniformLoc(gl, entry, name);
    if (loc == null) continue; // not present / optimized out
    const rt = asRenderTarget(value);
    if (rt != null) {
      // CRITICAL: resolve an RT *source* via initRenderTarget (the same
      // path the dst uses), NOT initTexture(rt.texture). An RT's color
      // texture is GL-created exclusively by textures.setupRenderTarget
      // (three.module.js:25842), which sets `__webglTexture` + `__version`
      // but NOT `__cacheKey` and never registers the texture in three's
      // `_sources` map. Routing rt.texture through initTexture →
      // setTexture2D → initTexture(props,tex) (three.module.js:24784) then
      // sees `textureCacheKey !== props.__cacheKey` (undefined), so it
      // CREATES A FRESH EMPTY gl.createTexture() and OVERWRITES
      // props.__webglTexture (three.module.js:24821/24856) — binding an
      // empty never-rendered texture → the shader samples all zeros.
      // initRenderTarget is idempotent and returns the RT's real
      // color-attachment handle.
      samplerBinds.push({
        loc,
        handle: resolveRtGlTexture(renderer, rt),
        unit,
      });
      boundUnits.push(unit);
      unit++;
      continue;
    }
    if (value instanceof THREE.Texture) {
      samplerBinds.push({
        loc,
        handle: resolveTexGlHandle(renderer, value),
        unit,
      });
      boundUnits.push(unit);
      unit++;
      continue;
    }
  }
  // Phase 2: raw-bind every resolved sampler handle to its unit. No three
  // call runs between these binds, so a unit, once bound, stays bound
  // through the draw.
  for (const sb of samplerBinds) {
    gl.activeTexture(gl.TEXTURE0 + sb.unit);
    gl.bindTexture(gl.TEXTURE_2D, sb.handle);
    gl.uniform1i(sb.loc, sb.unit);
  }
  // Non-sampler uniforms (no three-state interaction — order-independent).
  for (const name of Object.keys(uniforms)) {
    const u = uniforms[name];
    if (!u) continue;
    const value = u.value as unknown;
    const loc = uniformLoc(gl, entry, name);
    if (loc == null) continue; // not present / optimized out
    const gType = entry.type.get(name) ?? "unknown";

    // Samplers were handled in the two-phase block above.
    if (asRenderTarget(value) != null || value instanceof THREE.Texture) {
      continue;
    }

    // Vectors.
    if (value instanceof THREE.Vector2) {
      if (gType === "uvec2") {
        // The u64 hash seed: .x = lo32, .y = hi32 as uint bit-patterns.
        // MUST be uniform2ui — uniform2f would silently corrupt the bake.
        gl.uniform2ui(loc, value.x >>> 0, value.y >>> 0);
      } else if (gType === "ivec2") {
        gl.uniform2i(loc, value.x | 0, value.y | 0);
      } else {
        gl.uniform2f(loc, value.x, value.y);
      }
      continue;
    }
    if (value instanceof THREE.Vector3) {
      gl.uniform3f(loc, value.x, value.y, value.z);
      continue;
    }
    if (value instanceof THREE.Vector4) {
      gl.uniform4f(loc, value.x, value.y, value.z, value.w);
      continue;
    }

    // Scalars: int/uint vs float driven by the PARSED GLSL type.
    if (typeof value === "number") {
      if (gType === "int") {
        gl.uniform1i(loc, value | 0);
      } else if (gType === "uint") {
        gl.uniform1ui(loc, value >>> 0);
      } else {
        // float (default) — uFaceRes, uErodibility, …
        gl.uniform1f(loc, value);
      }
      continue;
    }
    if (typeof value === "boolean") {
      gl.uniform1i(loc, value ? 1 : 0);
      continue;
    }
    // Any other type is unexpected for the bake frags — skip silently
    // (a real type error would surface as a wrong-looking field, and the
    // parsed-type path above covers every uniform the bake actually uses).
  }

  // 7. Draw the fullscreen triangle.
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // 8. EXPLICIT cleanup — the whole point. Unbind every sampler unit we
  //    bound, then the FBO. dst was only ever a COLOR_ATTACHMENT0, never a
  //    sampler (GL-ALIAS proved no uniform == dst). With all sampler units
  //    null and the FBO unbound, no texture can be simultaneously a
  //    sampler source and the active framebuffer attachment on any
  //    subsequent pass → the "Feedback loop formed between Framebuffer and
  //    active Texture" condition cannot arise. Structurally impossible.
  for (const bu of boundUnits) {
    gl.activeTexture(gl.TEXTURE0 + bu);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindVertexArray(null);
  // Detach the dst texture from the FBO before unbinding (so the dst GL
  // texture is not even referenced by our FBO between passes).
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    null,
    0,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/**
 * Run ONE POINTS-primitive pass on the raw WebGL2 context into `dstRT`,
 * using a caller-supplied vertex shader (typically gl_VertexID-driven) and
 * `count` point sprites. Mirrors runRawPass's discipline byte-for-byte
 * (same two-phase sampler bind, same explicit cleanup) and differs only in
 * the 7 named ways: vert param, ensureProgramVF, _pointVao, optional
 * additive blend, POINTS draw call, blend restore, and count param.
 */
export function runPointPass(
  renderer: THREE.WebGLRenderer,
  vert: string,
  frag: string,
  count: number,
  uniforms: Record<string, THREE.IUniform>,
  dstRT: THREE.WebGLRenderTarget,
  opts?: { additive?: boolean },
): void {
  const gl = ensureGl(renderer);
  const entry = ensureProgramVF(gl, vert, frag);
  const fbo = _fbo as WebGLFramebuffer;
  if (_pointVao === null) _pointVao = gl.createVertexArray();
  const vao = _pointVao as WebGLVertexArrayObject;

  const dstGlTex = resolveRtGlTexture(renderer, dstRT);

  // 1-2. Bind our own FBO and (re)attach the dst's GL texture each pass.
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    dstGlTex,
    0,
  );

  // 3. (dev-gated) framebuffer completeness assert — a misconfigured
  // attachment should be loud, not a silently black pass.
  if (
    (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true
  ) {
    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(
        `glPass: framebuffer incomplete (0x${fbStatus.toString(16)})`,
      );
    }
  }

  // 4. Fixed-function state for an offscreen compute pass.
  gl.viewport(0, 0, dstRT.width, dstRT.height);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.CULL_FACE);
  gl.colorMask(true, true, true, true);
  if (opts?.additive) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
  }

  // 5. Program + geometry.
  gl.useProgram(entry.program);
  gl.bindVertexArray(vao);

  // 6. Upload uniforms by parsed GLSL type. Track sampler units bound so
  //    they can be explicitly unbound after the draw.
  //
  // SAMPLERS ARE TWO-PHASE (load-bearing — do NOT inline phase 2 into
  // phase 1). resolveRtGlTexture/resolveTexGlHandle call three's
  // renderer.initRenderTarget / renderer.initTexture, which on a
  // texture/RT's FIRST use run textures.setupRenderTarget /
  // textures.setTexture2D. Those go through three's WebGLState and issue
  // REAL gl.activeTexture(TEXTURE0+slot)/gl.bindTexture (slot defaults to
  // 0) plus a state.texImage2D upload. If we resolved+raw-bound samplers
  // one-by-one, the resolve of sampler N (e.g. uPrecip, a DataTexture's
  // first upload) would clobber the raw bind we already did for sampler
  // N-1 on its unit (e.g. uA on unit 0) — three's setTexture2D rebinds
  // unit 0. The shader then samples the wrong texture for the earlier unit
  // (uA reads zeros while only the later sampler is correct → the exact
  // "terrain/ocean collapse, water-only updates" failure). So: PHASE 1
  // resolves EVERY sampler handle (all three-state touches happen here,
  // before any raw unit bind); PHASE 2 raw-binds the resolved handles to
  // units with NO three call interleaved, so nothing can clobber a unit
  // after it is bound.
  let unit = 0;
  const boundUnits: number[] = [];
  // Phase 1: resolve all sampler GL handles + assign units (three's lazy
  // init/upload may bind textures on its own units here — harmless now,
  // because no raw unit binds have happened yet).
  const samplerBinds: {
    loc: WebGLUniformLocation;
    handle: WebGLTexture;
    unit: number;
  }[] = [];
  for (const name of Object.keys(uniforms)) {
    const u = uniforms[name];
    if (!u) continue;
    const value = u.value as unknown;
    const loc = uniformLoc(gl, entry, name);
    if (loc == null) continue; // not present / optimized out
    const rt = asRenderTarget(value);
    if (rt != null) {
      // CRITICAL: resolve an RT *source* via initRenderTarget (the same
      // path the dst uses), NOT initTexture(rt.texture). An RT's color
      // texture is GL-created exclusively by textures.setupRenderTarget
      // (three.module.js:25842), which sets `__webglTexture` + `__version`
      // but NOT `__cacheKey` and never registers the texture in three's
      // `_sources` map. Routing rt.texture through initTexture →
      // setTexture2D → initTexture(props,tex) (three.module.js:24784) then
      // sees `textureCacheKey !== props.__cacheKey` (undefined), so it
      // CREATES A FRESH EMPTY gl.createTexture() and OVERWRITES
      // props.__webglTexture (three.module.js:24821/24856) — binding an
      // empty never-rendered texture → the shader samples all zeros.
      // initRenderTarget is idempotent and returns the RT's real
      // color-attachment handle.
      samplerBinds.push({
        loc,
        handle: resolveRtGlTexture(renderer, rt),
        unit,
      });
      boundUnits.push(unit);
      unit++;
      continue;
    }
    if (value instanceof THREE.Texture) {
      samplerBinds.push({
        loc,
        handle: resolveTexGlHandle(renderer, value),
        unit,
      });
      boundUnits.push(unit);
      unit++;
      continue;
    }
  }
  // Phase 2: raw-bind every resolved sampler handle to its unit. No three
  // call runs between these binds, so a unit, once bound, stays bound
  // through the draw.
  for (const sb of samplerBinds) {
    gl.activeTexture(gl.TEXTURE0 + sb.unit);
    gl.bindTexture(gl.TEXTURE_2D, sb.handle);
    gl.uniform1i(sb.loc, sb.unit);
  }
  // Non-sampler uniforms (no three-state interaction — order-independent).
  for (const name of Object.keys(uniforms)) {
    const u = uniforms[name];
    if (!u) continue;
    const value = u.value as unknown;
    const loc = uniformLoc(gl, entry, name);
    if (loc == null) continue; // not present / optimized out
    const gType = entry.type.get(name) ?? "unknown";

    // Samplers were handled in the two-phase block above.
    if (asRenderTarget(value) != null || value instanceof THREE.Texture) {
      continue;
    }

    // Vectors.
    if (value instanceof THREE.Vector2) {
      if (gType === "uvec2") {
        // The u64 hash seed: .x = lo32, .y = hi32 as uint bit-patterns.
        // MUST be uniform2ui — uniform2f would silently corrupt the bake.
        gl.uniform2ui(loc, value.x >>> 0, value.y >>> 0);
      } else if (gType === "ivec2") {
        gl.uniform2i(loc, value.x | 0, value.y | 0);
      } else {
        gl.uniform2f(loc, value.x, value.y);
      }
      continue;
    }
    if (value instanceof THREE.Vector3) {
      gl.uniform3f(loc, value.x, value.y, value.z);
      continue;
    }
    if (value instanceof THREE.Vector4) {
      gl.uniform4f(loc, value.x, value.y, value.z, value.w);
      continue;
    }

    // Scalars: int/uint vs float driven by the PARSED GLSL type.
    if (typeof value === "number") {
      if (gType === "int") {
        gl.uniform1i(loc, value | 0);
      } else if (gType === "uint") {
        gl.uniform1ui(loc, value >>> 0);
      } else {
        // float (default) — uFaceRes, uErodibility, …
        gl.uniform1f(loc, value);
      }
      continue;
    }
    if (typeof value === "boolean") {
      gl.uniform1i(loc, value ? 1 : 0);
      continue;
    }
    // Any other type is unexpected for the bake frags — skip silently
    // (a real type error would surface as a wrong-looking field, and the
    // parsed-type path above covers every uniform the bake actually uses).
  }

  // 7. Draw the point sprites.
  gl.drawArrays(gl.POINTS, 0, count);

  // 8. EXPLICIT cleanup — the whole point. Unbind every sampler unit we
  //    bound, then the FBO. dst was only ever a COLOR_ATTACHMENT0, never a
  //    sampler (GL-ALIAS proved no uniform == dst). With all sampler units
  //    null and the FBO unbound, no texture can be simultaneously a
  //    sampler source and the active framebuffer attachment on any
  //    subsequent pass → the "Feedback loop formed between Framebuffer and
  //    active Texture" condition cannot arise. Structurally impossible.
  for (const bu of boundUnits) {
    gl.activeTexture(gl.TEXTURE0 + bu);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindVertexArray(null);
  // Detach the dst texture from the FBO before unbinding (so the dst GL
  // texture is not even referenced by our FBO between passes).
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    null,
    0,
  );
  if (opts?.additive) {
    gl.disable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ZERO);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/**
 * Read RGBA32F pixels from a three RenderTarget on the raw WebGL2 context,
 * via OUR own FBO — NOT three's `readRenderTargetPixels`.
 *
 * three's `readRenderTargetPixels` (three.module.js:31118) binds the RT's
 * FBO through `state.bindFramebuffer`, which SKIPS the real
 * `gl.bindFramebuffer` when three's `currentBoundFramebuffers` cache still
 * thinks that FBO is bound (three.module.js:23099). Because every bake
 * pass ran on the raw context and left the real FBO binding at `null`
 * WITHOUT updating three's cache, that cache is stale: a cache-hit skip
 * would make `readPixels` read the default framebuffer (canvas) → a wrong
 * `global_min` → corrupted PD pit-fill. Reading through our own FBO with a
 * direct `gl.bindFramebuffer` (no three cache) eliminates that hazard and
 * is consistent with the rest of the bake bypassing three's renderer.
 *
 * `buf` must be a `Float32Array` of length `w*h*4` (the RGBA32F bake RTs).
 */
export function readRawPixels(
  renderer: THREE.WebGLRenderer,
  rt: THREE.WebGLRenderTarget,
  x: number,
  y: number,
  w: number,
  h: number,
  buf: Float32Array,
): void {
  const gl = ensureGl(renderer);
  const fbo = _fbo as WebGLFramebuffer;
  const glTex = resolveRtGlTexture(renderer, rt);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    glTex,
    0,
  );
  // RGBA32F render targets read as RGBA/FLOAT (EXT_color_buffer_float was
  // hard-guarded at createPingPong; these RTs are always float-renderable).
  gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, buf);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    null,
    0,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/**
 * Dispose every cached program + the module-level GL resources. The bake
 * orchestrator must NOT call this between passes (the program cache must
 * survive the whole bake); only at end-of-app teardown if ever needed.
 * Not currently wired into runErodeBake teardown — the programs are cheap
 * and reused across bakes; provided for completeness/tests.
 */
export function disposeGlPassCache(): void {
  const gl = _gl;
  if (gl) {
    for (const e of _programs.values()) gl.deleteProgram(e.program);
    if (_fbo) gl.deleteFramebuffer(_fbo);
    if (_vbo) gl.deleteBuffer(_vbo);
    if (_vao) gl.deleteVertexArray(_vao);
    if (_pointVao) gl.deleteVertexArray(_pointVao);
  }
  _programs.clear();
  _fbo = null;
  _vbo = null;
  _vao = null;
  _pointVao = null;
  _gl = null;
}

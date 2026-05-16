// RGBA32F ping-pong framework + float-support hard guard (Task A12).
//
// Phase A2 ports the CPU erosion oracle to the GPU using Three.js r0.169
// WebGL2 with raw ShaderMaterial / WebGLRenderTarget (NO compute shaders).
// Erosion steps read the previous state of a channel and write the next
// state, so each channel needs a *pair* of float render targets that get
// flipped ("ping-pong") after every pass.
//
// Three concerns live here:
//   1. PingPongBook        — pure per-channel read/write index bookkeeping.
//   2. decideFloatSupport  — pure float-capability probe (HARDENING).
//   3. createPingPong      — allocate paired RGBA32F render targets.
//   4. runPass             — fullscreen-quad render helper.
//
// Only (1) and (2) (plus createPingPong's probing branch via an injected
// fake ctx) are unit-tested — there is no headless WebGL in this repo. The
// GL allocation / runPass paths are exercised by the A18 parity harness.

import * as THREE from "three";

// TODO(bake-debug): remove after feedback-loop root-caused.
// Dev-only structural self-alias detector for the GPU bake. Gated by both
// an explicit module const AND import.meta.env.DEV so the production build
// is byte-for-byte unaffected (Vite tree-shakes the dead branch). Flip
// BAKE_DEBUG to false (or delete this block + its call sites) to disable.
// Used by runPass (pingpong.ts) and runInto (erodePipeline.ts) to print
// the EXACT pass whose uniforms sample the very texture it draws into.
export const BAKE_DEBUG = true;
// `import.meta.env` is Vite-injected and statically replaced in the
// browser build (so the prod branch tree-shakes away); under bare Node
// test runners (tsx) it is `undefined`, hence the `unknown`-cast optional
// chain — keeps tsc happy (Vite types it as always-defined) AND avoids a
// "Cannot read properties of undefined" throw in the headless bake tests.
const _isDev =
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
const _bakeDbgOn = BAKE_DEBUG && _isDev;
// One log per distinct fragment-shader id so a real alias is ALWAYS shown
// at least once but the console is not flooded across thousands of passes.
const _bakeAliasSeen = new Set<string>();
/** Short, stable id for a fragment source (first GLSL signature-ish line). */
function _fragId(frag: string): string {
  const m = frag.match(/[a-zA-Z_][\w]*\s*\(/);
  const head = (m ? m[0] : frag.slice(0, 24)).replace(/\s+/g, "");
  return `${head}#${frag.length}`;
}
/**
 * TODO(bake-debug): remove after feedback-loop root-caused.
 * If any uniform value is the texture this pass draws into (a true
 * same-pass structural feedback alias), log it once per distinct shader.
 * Also checks the RT object identity in case `.texture` is swapped.
 */
function _checkSelfAlias(
  where: string,
  frag: string,
  uniforms: Record<string, THREE.IUniform>,
  dst: THREE.WebGLRenderTarget,
): void {
  if (!_bakeDbgOn) return;
  const dstTex = dst.texture as unknown;
  for (const name of Object.keys(uniforms)) {
    const v = uniforms[name]?.value as unknown;
    if (v == null) continue;
    const aliases =
      v === dstTex ||
      (v instanceof THREE.Texture && v === dst.texture) ||
      // RT passed directly as a uniform (its .texture is the attachment).
      (v as { isWebGLRenderTarget?: boolean }).isWebGLRenderTarget === true &&
        (v as THREE.WebGLRenderTarget).texture === dst.texture;
    if (aliases) {
      const fid = _fragId(frag);
      const key = `${where}:${fid}:${name}`;
      if (_bakeAliasSeen.has(key)) return;
      _bakeAliasSeen.add(key);
      // eslint-disable-next-line no-console
      console.error(
        `[bake-feedback] SELF-ALIAS where=${where} frag=${fid} uniform=${name} ` +
          `(this uniform texture === the dst render-target this pass draws into)`,
      );
      return;
    }
  }
}
/** TODO(bake-debug): remove after feedback-loop root-caused. */
export const _bakeDebug = {
  on: _bakeDbgOn,
  fragId: _fragId,
  checkSelfAlias: _checkSelfAlias,
  resetSeen(): void {
    _bakeAliasSeen.clear();
  },
};

// TODO(bake-debug): remove after feedback-loop root-caused.
// One STALE-UNIT-ALIAS log per distinct fragment so the mechanism is
// confirmed at least once per shader without flooding the console across
// thousands of passes.
const _bakeStaleSeen = new Set<string>();

/**
 * Minimal structural shape of the raw WebGL2 calls we use for binding
 * hygiene. `renderer.getContext()` returns the real `WebGL2RenderingContext`
 * in three r0.169 (WebGL2-only). The unit tests' fake renderer returns a
 * context that ONLY implements `getExtension` (for `createPingPong`'s probe)
 * — but the tests never reach `runPass`/`runInto`, so this path is real-only.
 * The defensive typeof guards below additionally make the whole hygiene
 * block a safe no-op if `getContext()` ever lacks these methods, WITHOUT
 * weakening the real render path (a real WebGL2 context always has them).
 */
interface GlBindingCtx {
  MAX_TEXTURE_IMAGE_UNITS: number;
  TEXTURE0: number;
  TEXTURE_2D: number;
  ACTIVE_TEXTURE: number;
  TEXTURE_BINDING_2D: number;
  getParameter(pname: number): unknown;
  activeTexture(texture: number): void;
  bindTexture(target: number, texture: unknown): void;
}

/**
 * FEEDBACK-LOOP KILL — physically isolate this pass's texture units.
 *
 * three r0.169 only tracks bound sampler textures in a JS-side cache and
 * SKIPS `gl.bindTexture` when it thinks a texture is "already" on a unit.
 * `renderer.resetState()` clears that JS cache but does NOT issue any
 * `gl.bindTexture(unit, null)` — so a texture bound to a high GL texture
 * unit by an EARLIER `runInto`/`runPass` survives physically. When a later
 * pass does `setRenderTarget(dst); render()` and that stale texture IS
 * `dst`'s color attachment, Chrome/ANGLE flags "Feedback loop formed
 * between Framebuffer and active Texture" and DISCARDS the draw → the
 * erosion field degenerates.
 *
 * Fix: AFTER `setRenderTarget(dst)` and BEFORE `render()`, physically bind
 * `null` to EVERY texture unit via the raw context. The SELF-ALIAS detector
 * already proved none of this pass's own sampler uniforms === `dst.texture`;
 * combined with every other unit now being physically null, NO bound texture
 * can alias the dst FBO ⇒ the feedback loop is impossible by construction.
 *
 * Why NOT `renderer.resetState()` here (three r0.169, source-verified):
 * `resetState()` → `state.reset()` raw-issues
 * `gl.bindFramebuffer(FRAMEBUFFER/DRAW/READ, null)` + `gl.viewport(0,0,
 * canvas.w,canvas.h)` and sets `_currentRenderTarget = null`
 * (three.module.js resetState @31537, state.reset bindFramebuffer @23826-
 * 23828 / viewport @23835). `renderer.render()` (@29852-30011) contains NO
 * `bindFramebuffer`/`setRenderTarget` — only `renderer.setRenderTarget()`
 * binds the dst FBO. So calling `resetState()` AFTER `setRenderTarget(dst)`
 * and BEFORE `render()` UNBINDS the dst FBO mid-pass: every bake draw lands
 * on the default framebuffer (canvas) and the dst RT stays zero → erosion
 * produces nothing. The per-unit null-bind loop ALONE kills the stale
 * alias; three re-binds THIS material's samplers from scratch each draw via
 * `setProgram` → `textures.resetTextureUnits()` (@30501/@30505), so dropping
 * `resetState()` does NOT leave samplers unbound. NEVER call `resetState()`
 * (or any framebuffer-touching reset) per-pass between setRenderTarget and
 * render.
 *
 * Must be called with the dst RT already bound (renderer.setRenderTarget(dst)
 * done) and before renderer.render(...).
 *
 * Phase-3 perf note: the per-pass full-unit unbind + per-pass
 * `getParameter(MAX_TEXTURE_IMAGE_UNITS)` is heavy at high resolution
 * (thousands of passes). It is correct and acceptable at the low debug-bake
 * config; narrow it later (cache the cap; unbind only units this pass uses).
 * Do NOT optimize now — correctness first.
 *
 * TODO(bake-debug): the dev-gated STALE-UNIT-ALIAS probe inside (runs
 * BEFORE the unbind) is debug-only — remove after feedback-loop root-caused.
 */
function physicallyIsolateUnits(
  renderer: THREE.WebGLRenderer,
  where: "runInto" | "runPass",
  frag: string,
  dst: THREE.WebGLRenderTarget,
): void {
  const gl = renderer.getContext() as unknown as Partial<GlBindingCtx>;
  // Defensive: only proceed on a real WebGL2 context (the unit tests'
  // fake renderer has none of these — though it never reaches here). This
  // does NOT weaken the real path: a real WebGL2RenderingContext always
  // implements all of these.
  if (
    !gl ||
    typeof gl.getParameter !== "function" ||
    typeof gl.activeTexture !== "function" ||
    typeof gl.bindTexture !== "function"
  ) {
    return;
  }
  const g = gl as GlBindingCtx;
  const maxUnits = g.getParameter(g.MAX_TEXTURE_IMAGE_UNITS) as number;

  // TODO(bake-debug): remove after feedback-loop root-caused. Dev-only
  // stale-unit probe — runs BEFORE the unbind so on a FIXED build the user
  // still sees STALE-UNIT-ALIAS lines (proving the stale-binding mechanism
  // + which unit) while the unbind right after neutralizes it (no GL
  // "Feedback loop" spam, healthy field). On a still-broken build the probe
  // + bake summary localize the next step.
  if (_bakeDbgOn) {
    // `__webglTexture` is a stable three r0.169 internal on the
    // WebGLProperties entry (not in the public typings) — used here ONLY
    // behind the dev gate to compare the dst's GL texture against bound
    // units. The cast is the documented way to reach it.
    const dstProps = renderer.properties.get(dst.texture) as
      | { __webglTexture?: unknown }
      | undefined;
    const dstGlTex = dstProps?.__webglTexture as unknown;
    if (dstGlTex != null) {
      const savedActive = g.getParameter(g.ACTIVE_TEXTURE) as number;
      for (let u = 0; u < maxUnits; u++) {
        g.activeTexture(g.TEXTURE0 + u);
        const bound = g.getParameter(g.TEXTURE_BINDING_2D) as unknown;
        if (bound != null && bound === dstGlTex) {
          const fid = _fragId(frag);
          const key = `${where}:${fid}:${u}`;
          if (!_bakeStaleSeen.has(key)) {
            _bakeStaleSeen.add(key);
            // eslint-disable-next-line no-console
            console.error(
              `[bake-feedback] STALE-UNIT-ALIAS unit=${u} where=${where} ` +
                `frag=${fid}`,
            );
          }
          break;
        }
      }
      g.activeTexture(savedActive);
    }
  }

  // Physically unbind ALL texture units. This ALONE kills the stale
  // physical alias (a texture bound to a high unit by an earlier pass that
  // is also this pass's dst FBO attachment). Do NOT call
  // `renderer.resetState()` here: it raw-unbinds the dst framebuffer
  // mid-pass (see the "Why NOT resetState()" block above) so the bake draw
  // would hit the canvas instead of the RT. three re-binds this material's
  // own samplers from scratch on the next `render()` via
  // `setProgram`→`textures.resetTextureUnits()`, so no resync is needed.
  // Save/restore the active texture unit so this hygiene loop leaves the
  // active-unit GL state exactly as three left it (three expects unit 0).
  const savedActiveUnit = g.getParameter(g.ACTIVE_TEXTURE) as number;
  for (let u = 0; u < maxUnits; u++) {
    g.activeTexture(g.TEXTURE0 + u);
    g.bindTexture(g.TEXTURE_2D, null);
  }
  g.activeTexture(savedActiveUnit);
}

/** TODO(bake-debug): remove after feedback-loop root-caused. */
export const _bakeUnitHygiene = {
  isolate: physicallyIsolateUnits,
  resetStaleSeen(): void {
    _bakeStaleSeen.clear();
  },
};

/** Read/write index for a single channel: 0 or 1. */
export type PingPongIndex = 0 | 1;

/**
 * Per-channel read/write index bookkeeping.
 *
 * Each channel starts reading slot 0 / writing slot 1. `swap(ch)` flips
 * that channel's index after a pass has written its result. Channels are
 * fully independent — swapping one does not move any other.
 */
export class PingPongBook {
  private readonly idx = new Map<string, PingPongIndex>();

  constructor(channels: string[]) {
    for (const ch of channels) this.idx.set(ch, 0);
  }

  private get(ch: string): PingPongIndex {
    const v = this.idx.get(ch);
    if (v === undefined) {
      throw new Error(`unknown ping-pong channel: ${ch}`);
    }
    return v;
  }

  /** Slot currently holding the channel's readable state (0 or 1). */
  read(ch: string): PingPongIndex {
    return this.get(ch);
  }

  /** Slot to render the channel's next state into (opposite of read). */
  write(ch: string): PingPongIndex {
    return (this.get(ch) ^ 1) as PingPongIndex;
  }

  /** Flip the channel's read/write slots after its pass has written. */
  swap(ch: string): void {
    this.idx.set(ch, (this.get(ch) ^ 1) as PingPongIndex);
  }

  /** All registered channel names (insertion order). */
  channels(): readonly string[] {
    return [...this.idx.keys()];
  }
}

/** Minimal structural shape of the bits of WebGL2 we probe. */
export interface GlExtensionProbe {
  getExtension(name: string): unknown;
}

/** Result of the float-capability probe. */
export interface FloatSupport {
  /** EXT_color_buffer_float present — can render *to* RGBA32F at all. */
  ok32f: boolean;
  /** OES_texture_float_linear present — hardware bilinear on float tex. */
  floatLinearOk: boolean;
  /**
   * True when float-linear is missing: RTs fall back to NearestFilter and
   * downstream upsample/resample shaders must do explicit 4-tap bilinear.
   */
  manualBilinear: boolean;
}

/**
 * Pure float-capability probe (HARDENING, NORMATIVE).
 *
 * `EXT_color_buffer_float` only enables *rendering* to float; it does NOT
 * guarantee hardware *bilinear* sampling of float textures
 * (`OES_texture_float_linear`, missing on some Apple-Silicon / mobile GPUs).
 * If float-linear is absent, LinearFilter silently degrades to nearest →
 * stair-stepped rivers in the upsample/resample. We surface that here so
 * A14/A15/A19 can switch to an explicit 4-tap manual bilinear in GLSL.
 *
 * A14/A15/A19 MUST read the returned `PingPongTargets.manualBilinear`;
 * there is no module-global float-linear flag (it would be last-write-wins
 * / externally mutable). The per-instance value is the single source of
 * truth for shader selection.
 *
 * Split out as a pure function so the decision is unit-testable with an
 * injected fake `{ getExtension }` context (no real WebGL2 required).
 */
export function decideFloatSupport(gl: GlExtensionProbe): FloatSupport {
  const ok32f = gl.getExtension("EXT_color_buffer_float") != null;
  const floatLinearOk = gl.getExtension("OES_texture_float_linear") != null;
  return { ok32f, floatLinearOk, manualBilinear: !floatLinearOk };
}

/** Factory for a render target — injectable so the probe path is testable. */
export type RenderTargetFactory = (
  w: number,
  h: number,
  opts: THREE.RenderTargetOptions,
) => THREE.WebGLRenderTarget;

const defaultRtFactory: RenderTargetFactory = (w, h, opts) =>
  new THREE.WebGLRenderTarget(w, h, opts);

/** A paired set of float render targets, one pair per channel. */
export interface PingPongTargets {
  /** rt[channel] = [slot0, slot1]. */
  rt: Record<string, [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]>;
  book: PingPongBook;
  /** Texture filter chosen for the targets (Linear or Nearest). */
  filter: THREE.TextureFilter;
  /** True when float-linear is unavailable (manual 4-tap bilinear needed). */
  manualBilinear: boolean;
  /** EXT_color_buffer_float present (always true here — else we threw). */
  ok32f: boolean;
  /** Release every render target. */
  dispose(): void;
}

/**
 * Allocate paired RGBA32F render targets, one pair per channel.
 *
 * HARDENING (NORMATIVE): probe `EXT_color_buffer_float` — if absent, throw
 * a clear Error (RGBA32F render targets are simply unsupported). SEPARATELY
 * probe `OES_texture_float_linear`; when absent the targets use
 * `NearestFilter` and `manualBilinear` is true so downstream shaders do an
 * explicit 4-tap bilinear, otherwise `LinearFilter`.
 *
 * `rtFactory` is injectable purely so the extension-probing + manualBilinear
 * decision is unit-testable with a fake ctx + fake renderer (no real GL).
 */
export function createPingPong(
  renderer: THREE.WebGLRenderer,
  w: number,
  h: number,
  channels: string[],
  rtFactory: RenderTargetFactory = defaultRtFactory,
): PingPongTargets {
  const gl = renderer.getContext() as unknown as GlExtensionProbe;
  const support = decideFloatSupport(gl);

  if (!support.ok32f) {
    throw new Error(
      "RGBA32F render targets unsupported (EXT_color_buffer_float)",
    );
  }

  const filter: THREE.TextureFilter = support.manualBilinear
    ? THREE.NearestFilter
    : THREE.LinearFilter;

  const rtOpts: THREE.RenderTargetOptions = {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  };

  const rt: Record<
    string,
    [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  > = {};
  for (const ch of channels) {
    rt[ch] = [rtFactory(w, h, rtOpts), rtFactory(w, h, rtOpts)];
  }

  return {
    rt,
    book: new PingPongBook(channels),
    filter,
    manualBilinear: support.manualBilinear,
    ok32f: support.ok32f,
    dispose() {
      for (const ch of Object.keys(rt)) {
        rt[ch][0].dispose();
        rt[ch][1].dispose();
      }
    },
  };
}

/* -------------------------------------------------------------------------
 * Fullscreen-quad pass helper.
 *
 * Renders a single fragment shader over a unit quad into the *write* RT of
 * `outChannel`, then flips that channel's ping-pong slot. This path needs a
 * real GL context at runtime and is exercised by A15/A18 — not unit-tested
 * here. Kept minimal & correct; the camera/quad are created once and reused.
 * ---------------------------------------------------------------------- */

const QUAD_VERT =
  "void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }";

let _quadScene: THREE.Scene | null = null;
let _quadCamera: THREE.OrthographicCamera | null = null;
let _quadMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null =
  null;

/**
 * Materials keyed by fragment-shader source string. Three.js compiles a
 * ShaderMaterial's GLSL program lazily on first render; a fresh material
 * per `runPass` call would recompile the shader every pass — catastrophic
 * in A15's hot pyramid loop (thousands of calls). Caching by source means
 * distinct shaders get distinct (independent, non-corrupting) materials
 * while identical/repeated passes reuse one already-compiled program.
 */
const _matCache = new Map<string, THREE.ShaderMaterial>();

function ensureQuad(): {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
} {
  if (_quadScene && _quadCamera && _quadMesh) {
    return { scene: _quadScene, camera: _quadCamera, mesh: _quadMesh };
  }
  const scene = new THREE.Scene();
  // Unit quad spanning the full clip-space NDC with an ortho camera.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);
  // Placeholder material; runPass swaps in the per-fragment-source cached
  // material before every render (the mesh material is never rendered as-is).
  const material = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT,
    fragmentShader: "void main(){ gl_FragColor = vec4(0.0); }",
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  _quadScene = scene;
  _quadCamera = camera;
  _quadMesh = mesh;
  return { scene, camera, mesh };
}

/** Look up (or lazily create) the cached material for a fragment source. */
function ensureMaterial(fragmentShader: string): THREE.ShaderMaterial {
  let mat = _matCache.get(fragmentShader);
  if (!mat) {
    mat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader,
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
    });
    _matCache.set(fragmentShader, mat);
  }
  return mat;
}

/**
 * Run one fullscreen fragment-shader pass into `outChannel`'s write RT,
 * then swap that channel's ping-pong slot.
 *
 * Materials are cached per fragment-shader source (see `_matCache`): the
 * GLSL program for a given shader is compiled once and reused across all
 * passes using that source, so the A15 hot loop never recompiles.
 */
export function runPass(
  renderer: THREE.WebGLRenderer,
  targets: PingPongTargets,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
  outChannel: string,
): void {
  const { scene, camera, mesh } = ensureQuad();

  const mat = ensureMaterial(fragmentShader);
  mat.uniforms = uniforms;
  mesh.material = mat;

  const pair = targets.rt[outChannel];
  if (!pair) {
    throw new Error(`runPass: unknown channel ${outChannel}`);
  }
  const dst = pair[targets.book.write(outChannel)];

  // TODO(bake-debug): remove after feedback-loop root-caused. Dev-only:
  // catch a true same-pass structural alias (a uniform sampling `dst`).
  _checkSelfAlias("runPass", fragmentShader, uniforms, dst);

  // FEEDBACK-LOOP KILL (manual multi-pass ping-pong, three r0.169).
  // Runtime evidence narrowed this to a STALE PHYSICAL GL texture-unit
  // binding (NOT a same-pass uniform alias — SELF-ALIAS never fired — and
  // NOT a competing external render — rAF guard airtight). three only
  // tracks bound samplers in a JS cache and skips re-binding; a texture
  // bound by an EARLIER runInto/runPass survives physically, and when a
  // later pass binds that very RT as its draw-FBO color attachment the
  // texture is simultaneously a sampler source AND the active framebuffer
  // attachment → Chrome/ANGLE "Feedback loop formed between Framebuffer
  // and active Texture" → the draw is DISCARDED → degenerate field. A
  // bare resetState() (an earlier attempt) had ZERO effect because it only
  // clears three's JS cache, never issuing gl.bindTexture(unit, null) — and
  // calling it per-pass is actively HARMFUL (it raw-unbinds the dst FBO
  // mid-pass so the draw hits the canvas; see physicallyIsolateUnits).
  //
  // 5-step ordering (exact): getRenderTarget → setRenderTarget(dst) →
  // physically unbind ALL units (before render, NO resetState) → render →
  // setRenderTarget(prev) → book.swap. After the physical unbind every
  // other unit is physically null and three re-binds ONLY this pass's own
  // samplers from scratch on the next render (setProgram →
  // resetTextureUnits); the SELF-ALIAS detector already proved none of
  // this pass's own sampler uniforms === dst.texture ⇒ no bound texture
  // can alias the dst FBO ⇒ feedback loop impossible by construction.
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(dst);
  physicallyIsolateUnits(renderer, "runPass", fragmentShader, dst);
  renderer.render(scene, camera);
  renderer.setRenderTarget(prevTarget);

  targets.book.swap(outChannel);
}

/**
 * Dispose every cached `runPass` material and clear the cache, freeing the
 * compiled GPU programs. Called by A15 at end-of-bake teardown — never from
 * within this module (the cache must survive across passes during a bake).
 */
export function disposeRunPassCache(): void {
  for (const mat of _matCache.values()) mat.dispose();
  _matCache.clear();
}

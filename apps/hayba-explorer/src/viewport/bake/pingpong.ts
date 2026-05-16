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
// TODO(bake-debug): remove after feedback-loop root-caused.
// GL-TEXTURE-IDENTITY alias detector. The SELF-ALIAS probe above compares
// THREE.Texture JS-object identity (`uniform.value === dst.texture`) and
// NEVER fires; the STALE-UNIT-ALIAS probe (in physicallyIsolateUnits)
// compares per-GL-unit `TEXTURE_BINDING_2D` vs the dst's
// `__webglTexture` and DOES fire. The disagreement means a pass's sampler
// uniform is a DIFFERENT THREE.Texture object but resolves to the SAME
// underlying GL `__webglTexture` as that pass's destination RT — a true
// same-target read==write at the GL level the JS-identity check misses
// (e.g. two distinct WebGLRenderTarget objects whose GL texture *name* the
// driver/three RECYCLED after a disposeScratch churn while an old uniform
// reference lingers). This probe resolves BOTH sides to their actual GL
// texture handle and names the EXACT (frag, uniform) doing it.
//
// Dedupe sets — one GL-ALIAS line per distinct (where,frag,uniform); one
// GL-PROBE line per distinct (where,frag) listing its texture-uniform
// keys (so frag ids map to a shader's sampler set). Low-volume by design.
const _bakeGlAliasSeen = new Set<string>();
const _bakeGlProbeSeen = new Set<string>();

/** Is a uniform value a THREE.Texture (incl. via an RT's `.texture`)? */
function _asTexture(v: unknown): THREE.Texture | null {
  if (v == null) return null;
  if ((v as { isWebGLRenderTarget?: boolean }).isWebGLRenderTarget === true) {
    const t = (v as THREE.WebGLRenderTarget).texture;
    return t instanceof THREE.Texture ? t : null;
  }
  return v instanceof THREE.Texture ? v : null;
}

/** Resolve a texture's backing GL handle via three's WebGLProperties. */
function _glTexOf(
  renderer: THREE.WebGLRenderer,
  tex: THREE.Texture,
): unknown {
  // `__webglTexture` is the stable three r0.169 internal on the
  // WebGLProperties entry (not in public typings) — the SAME cast the
  // STALE-UNIT-ALIAS probe already uses; dev-gate only.
  const props = renderer.properties.get(tex) as
    | { __webglTexture?: unknown }
    | undefined;
  return props?.__webglTexture;
}

/**
 * TODO(bake-debug): remove after feedback-loop root-caused.
 * Name the EXACT pass + uniform whose sampler resolves to the SAME GL
 * texture as the pass's destination RT. For each texture-bearing uniform:
 * resolve its `__webglTexture` and the dst's `__webglTexture`; if both are
 * defined and equal, log one `GL-ALIAS` line per (where,frag,uniform).
 * Also logs one `GL-PROBE` line per (where,frag) naming its texture
 * uniform keys so frag ids map to shaders. Pass `renderer` (needed to
 * reach WebGLProperties — the SELF-ALIAS probe did not have it).
 */
function _checkGlAlias(
  renderer: THREE.WebGLRenderer,
  where: string,
  frag: string,
  uniforms: Record<string, THREE.IUniform>,
  dst: THREE.WebGLRenderTarget,
): void {
  if (!_bakeDbgOn) return;
  const fid = _fragId(frag);

  // GL-PROBE — once per (where,frag): list the texture-uniform KEY names
  // so the user can map every frag id to its shader's sampler set even
  // when no alias fires (helps interpret which pass is which).
  const probeKey = `${where}:${fid}`;
  if (!_bakeGlProbeSeen.has(probeKey)) {
    _bakeGlProbeSeen.add(probeKey);
    const texNames: string[] = [];
    for (const name of Object.keys(uniforms)) {
      if (_asTexture(uniforms[name]?.value) != null) texNames.push(name);
    }
    // eslint-disable-next-line no-console
    console.error(
      `[bake-feedback] GL-PROBE frag=${fid} where=${where} ` +
        `texUniforms=[${texNames.join(",")}]`,
    );
  }

  const dstGl = _glTexOf(renderer, dst.texture);
  if (dstGl == null) return; // dst not yet GL-allocated → nothing to alias

  for (const name of Object.keys(uniforms)) {
    const v = uniforms[name]?.value as unknown;
    const tex = _asTexture(v);
    if (tex == null) continue;
    const uGl = _glTexOf(renderer, tex);
    if (uGl == null || uGl !== dstGl) continue;
    const key = `${where}:${fid}:${name}`;
    if (_bakeGlAliasSeen.has(key)) continue;
    _bakeGlAliasSeen.add(key);
    // Does the uniform's OWNING RT (if it was passed as an RT, or if the
    // texture is literally dst.texture) === the dst RT object? Helps tell
    // "same RT passed twice" (true) from "two different RTs sharing a
    // recycled GL texture name after disposeScratch" (false).
    const ownsSameRt =
      ((v as { isWebGLRenderTarget?: boolean }).isWebGLRenderTarget ===
        true &&
        (v as THREE.WebGLRenderTarget) === dst) ||
      tex === dst.texture;
    // eslint-disable-next-line no-console
    console.error(
      `[bake-feedback] GL-ALIAS frag=${fid} where=${where} ` +
        `uniform=${name} dstSameObjAsUniformRT=${ownsSameRt}`,
    );
  }
}

/** TODO(bake-debug): remove after feedback-loop root-caused. */
export const _bakeDebug = {
  on: _bakeDbgOn,
  fragId: _fragId,
  checkSelfAlias: _checkSelfAlias,
  checkGlAlias: _checkGlAlias,
  resetSeen(): void {
    _bakeAliasSeen.clear();
    _bakeGlAliasSeen.clear();
    _bakeGlProbeSeen.clear();
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
 * FEEDBACK-LOOP KILL — physically isolate units, resetState, re-bind dst.
 *
 * three r0.169 only tracks bound sampler textures in a JS-side cache
 * (`currentBoundTextures`) and SKIPS `gl.bindTexture` when it thinks a
 * texture is "already" on a unit. A texture bound to a high GL texture unit
 * by an EARLIER `runInto`/`runPass` survives physically. When a later pass
 * does `setRenderTarget(dst); render()` and that stale texture IS `dst`'s
 * color attachment, Chrome/ANGLE flags "Feedback loop formed between
 * Framebuffer and active Texture" and DISCARDS the draw → the erosion field
 * degenerates.
 *
 * TWO contrasting runtime results pinned the exact fix (not theory):
 *
 *  • Commit 9ebde89 (per-unit null-bind + `resetState()` AFTER
 *    setRenderTarget(dst), BEFORE render): ZERO "Feedback loop" GL errors —
 *    so `resetState()` IS what actually kills the loop (it wipes three's
 *    `currentBoundTextures` cache so three re-binds THIS material's samplers
 *    fresh on render → nothing aliases the FBO). BUT `resetState()` also
 *    raw-unbinds the dst FBO + sets canvas viewport, and `render()` does NOT
 *    re-bind the RT, so every bake draw hit the canvas → all bake RTs (incl.
 *    the returned equiRT) stayed zero → erosion produced nothing.
 *  • Commit 7b386c0 (per-unit null-bind ONLY, `resetState()` removed): the
 *    "Feedback loop … (×25)" GL errors RETURNED and STALE-UNIT-ALIAS still
 *    fired — so the per-unit null-bind loop ALONE does NOT prevent the loop
 *    (three re-binds the aliasing sampler on `render()` from its still-warm
 *    cache); field still wrong.
 *
 * SYNTHESIS — we need BOTH effects, in this exact order:
 *   1. physically `bindTexture(null)` every unit (defensive: drops any stale
 *      physical binding; restore the active unit so three's unit-0 invariant
 *      holds);
 *   2. `renderer.resetState()` — REQUIRED. This is what actually kills the
 *      feedback loop: `resetState()` → `state.reset()` wipes
 *      `currentBoundTextures = {}` (three.module.js @23842) so three's
 *      `setProgram` re-binds THIS pass's own samplers from scratch on the
 *      next `render()` → no stale sampler can alias the dst FBO. Per-unit
 *      null-bind alone is insufficient because three re-binds the aliasing
 *      sampler from its un-cleared JS cache on render (7b386c0 proved this).
 *   3. `renderer.setRenderTarget(dst)` AGAIN — `state.reset()` also raw-issues
 *      `gl.bindFramebuffer(FRAMEBUFFER/DRAW/READ,null)` + `gl.viewport(0,0,
 *      canvas.w,canvas.h)` and wipes `currentBoundFramebuffers = {}`
 *      (three.module.js resetState @31537, state.reset @23826-23828/@23835/
 *      @23844). So after step 2 the dst FBO is UNBOUND. Re-calling
 *      `setRenderTarget(dst)` re-binds it: because `currentBoundFramebuffers`
 *      was wiped, `state.bindFramebuffer` (@23097-23121) sees
 *      `undefined !== framebuffer` and ACTUALLY issues `gl.bindFramebuffer`
 *      (the cache-skip cannot suppress it), and `state.viewport(@31097)`
 *      re-applies the RT viewport. The caller's immediate `render()` then
 *      writes to dst, not the canvas (9ebde89's zero-field bug). This
 *      re-bind is the step BOTH prior attempts lacked.
 *
 * Must be called with the dst RT already bound (renderer.setRenderTarget(dst)
 * done) and before renderer.render(...); this helper ends with
 * `setRenderTarget(dst)` so the caller's next `render()` targets dst.
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

  // Step 1 — physically unbind ALL texture units (defensive: drop any
  // stale physical binding from an earlier pass). Save/restore the active
  // texture unit so this loop leaves the active-unit GL state exactly as
  // three left it (three's invariant expects unit 0).
  const savedActiveUnit = g.getParameter(g.ACTIVE_TEXTURE) as number;
  for (let u = 0; u < maxUnits; u++) {
    g.activeTexture(g.TEXTURE0 + u);
    g.bindTexture(g.TEXTURE_2D, null);
  }
  g.activeTexture(savedActiveUnit);

  // Step 2 — resetState() is what ACTUALLY kills the feedback loop: it
  // wipes three's `currentBoundTextures` cache so `setProgram` re-binds
  // THIS pass's own samplers fresh on the caller's next render() (nothing
  // stale can alias the dst FBO). Per-unit null-bind ALONE is insufficient:
  // three re-binds the aliasing sampler from its un-cleared JS cache on
  // render — commit 7b386c0 proved the loop returns without this; commit
  // 9ebde89 proved with this the loop is gone (zero "Feedback loop" errors).
  renderer.resetState();

  // Step 3 — resetState() ALSO raw-unbinds the dst framebuffer and sets the
  // canvas viewport (and wipes `currentBoundFramebuffers`), so re-bind dst
  // here. Because the FBO cache was just wiped, this setRenderTarget DOES
  // issue the real gl.bindFramebuffer + re-applies the RT viewport (the
  // cache-skip cannot suppress it). The caller's immediate render() then
  // writes to dst, not the canvas (the 9ebde89 zero-field bug). This
  // re-bind is the step both prior attempts lacked.
  renderer.setRenderTarget(dst);
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
  // TODO(bake-debug): remove after feedback-loop root-caused. Dev-only:
  // GL-texture-identity alias — names the EXACT (frag,uniform) whose
  // sampler resolves to the SAME __webglTexture as this pass's dst RT
  // (catches recycled-GL-name aliases the JS-identity SELF-ALIAS misses).
  _checkGlAlias(renderer, "runPass", fragmentShader, uniforms, dst);

  // FEEDBACK-LOOP KILL (manual multi-pass ping-pong, three r0.169).
  // Runtime evidence narrowed this to a STALE three.js texture-unit binding
  // (NOT a same-pass uniform alias — SELF-ALIAS never fired — and NOT a
  // competing external render — rAF guard airtight): three caches bound
  // samplers in JS and re-binds the aliasing sampler on render(), so when a
  // later pass binds that very RT as its draw-FBO color attachment the
  // texture is simultaneously a sampler source AND the active framebuffer
  // attachment → Chrome/ANGLE "Feedback loop formed between Framebuffer
  // and active Texture" → the draw is DISCARDED → degenerate field. The
  // fix, synthesized from TWO contrasting runtime results (9ebde89 had
  // resetState → zero feedback errors but zero field; 7b386c0 dropped it →
  // feedback errors returned), lives in physicallyIsolateUnits: unbind
  // units → resetState() (kills the loop) → setRenderTarget(dst) (re-bind
  // the FBO resetState cleared, so render() hits dst not the canvas).
  //
  // Ordering (exact): getRenderTarget → setRenderTarget(dst) →
  // physicallyIsolateUnits (unbind units → resetState → re-setRenderTarget
  // dst) → render → setRenderTarget(prev) → book.swap. The helper ends
  // bound to dst so this render() targets dst; the SELF-ALIAS detector
  // already proved none of this pass's own sampler uniforms === dst.texture
  // ⇒ no bound texture can alias the dst FBO ⇒ loop impossible.
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

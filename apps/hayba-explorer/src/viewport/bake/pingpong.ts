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

  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(dst);
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

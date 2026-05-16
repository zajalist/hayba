# Baking Pipeline — Subsystem A: Raster Bake + Multi-Scale Amplification Erosion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the painted Goldberg sphere, carve geomorphologically real high-frequency detail into it (without destroying macro relief), and produce an 8K equirectangular RGBA32F `h_final` heightmap — with a deterministic CPU reference oracle that the GPU path is validated against.

**Architecture:** Erosion is **solved on an equal-area cube-sphere** (6 faces, halo + corner exchange), via a multi-scale amplification pyramid (inject detail → stream-power/thermal/deposition → mass-conserving ×2 upsample), macro preserved by frequency separation, then **resampled to an 8K equirect** texture. A pure-Rust CPU implementation is built first as the TDD backbone and golden oracle; the GPU (Three.js WebGL2 ping-pong) path is ported from it and validated by low-res parity + visual checks (no headless-WebGL test harness exists in this repo, so GPU correctness = CPU-parity + visual, per the spec §11).

**Tech Stack:** Rust (`hayba-explorer/src-tauri`, `glam`, `serde`, `image`, `cargo test --lib`); TypeScript + Three.js r0.169 (`hayba-explorer/src`, `WebGLRenderTarget` ping-pong, GLSL ES via `.glsl.ts` template literals); TS tests run as `npx tsx <file>.test.ts` with `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-05-15-baking-pipeline-redesign-design.md` (§4 contracts, §5 Subsystem A, §11 testing, §12 risks). Read §5 + the §5.1/§5.4/§6 HARDENING blocks before starting.

---

## Conventions (read once)

- **Rust tests:** add `#[cfg(test)] mod tests { use super::*; … }` in-module; run `cd apps/hayba-explorer/src-tauri && cargo test --lib <filter>`. Follow existing patterns in `hydrology.rs`/`wizard.rs` (small deterministic fixtures, `assert!((a-b).abs() < eps)`).
- **TS logic tests:** create `src/viewport/bake/<name>.test.ts`, first line comment `// Run: npx tsx src/viewport/bake/<name>.test.ts`, use `import assert from "node:assert/strict"`. Pure logic only (no WebGL in tsx).
- **GPU tasks** have no unit test (no headless GL). Their "test" is the **parity harness** (Task A20) + a **visual checklist**. Each GPU task still commits independently.
- **Commit** after every task with the exact `git add <paths>` listed (only those paths — never `git add -A`). Commit messages: no `Co-Authored-By` trailer; do not touch gpg/hooks.
- **Determinism:** every stochastic function takes an explicit `seed: u64`; noise is evaluated at **3D sphere position** (never per-face UV) so it is seam-continuous (spec §5.4 step 1).
- Normalized elevation: ocean `[-1,0]`, land `(0,1]`. Erosion only mutates land texels; ocean is fixed base level.

## File Structure

**New — Rust (CPU oracle + command):**
- `apps/hayba-explorer/src-tauri/src/erosion/mod.rs` — module root, `ErosionConfig`, public `bake_erode_cpu()` entry, re-exports.
- `apps/hayba-explorer/src-tauri/src/erosion/cubesphere.rs` — equal-area cube-sphere grid: face/uv↔sphere-pos, neighbour + 1-ring halo, 8-corner 3-way adjacency, per-edge flux rotation table.
- `apps/hayba-explorer/src-tauri/src/erosion/noise.rs` — deterministic 3D simplex `fbm`, `ridged`, `worley`, `domain_warp` (sphere-position domain).
- `apps/hayba-explorer/src-tauri/src/erosion/pyramid.rs` — rasterize, detail-band inject, stream-power, thermal, conservative upsample, pyramid driver, frequency-sep blend.
- `apps/hayba-explorer/src-tauri/src/erosion/resample.rs` — cube-sphere → equirect.

**Modified — Rust:**
- `apps/hayba-explorer/src-tauri/src/lib.rs` — `mod erosion;` + register `wizard::bake_erode_v2` in `generate_handler!`.
- `apps/hayba-explorer/src-tauri/src/wizard.rs` — add `bake_erode_v2` command (rasterize source → CPU erode → return `ErodeResultV2`).

**New — TS (GPU port + integration):**
- `apps/hayba-explorer/src/viewport/bake/pingpong.ts` — RGBA32F `WebGLRenderTarget` pair + fullscreen-quad pass runner; `EXT_color_buffer_float` guard.
- `apps/hayba-explorer/src/viewport/bake/cubesphere.ts` — TS mirror of the cube-sphere math (forward/inverse, adjacency, corners) + `*.test.ts`.
- `apps/hayba-explorer/src/viewport/bake/passes.glsl.ts` — GLSL chunks (cube-face sampling, noise, stream-power, thermal, upsample, resample) as template literals.
- `apps/hayba-explorer/src/viewport/bake/erodePipeline.ts` — GPU pyramid orchestrator → `h_final` equirect `THREE.Texture`.
- `apps/hayba-explorer/src/viewport/bake/debugMaterial.ts` — equirect-sampling relief material for visual validation.

**Modified — TS:**
- `apps/hayba-explorer/src/App.tsx` — bake button path → GPU pipeline; progress state; cache `h_final`.
- `apps/hayba-explorer/src/viewport/scene.ts` — expose `renderer` for offscreen passes (already returned; add a `runBake(fn)` hook that pauses `tick` during a bake).

---

## Phase A0 — Foundations & contracts

### Task A1: Cube-sphere math (Rust)

**Files:**
- Create: `apps/hayba-explorer/src-tauri/src/erosion/mod.rs`
- Create: `apps/hayba-explorer/src-tauri/src/erosion/cubesphere.rs`
- Modify: `apps/hayba-explorer/src-tauri/src/lib.rs` (add `mod erosion;` after `mod hydrology;`)

- [ ] **Step 1: Write the failing test** — append to `cubesphere.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    #[test]
    fn sphere_pos_roundtrips_through_face_uv() {
        let g = CubeSphere::new(8); // 8x8 per face
        for &p in &[Vec3::new(0.3,0.7,-0.2), Vec3::new(-0.9,0.1,0.4), Vec3::Y] {
            let p = p.normalize();
            let (face, u, v) = g.sphere_to_face_uv(p);
            let q = g.face_uv_to_sphere(face, u, v);
            assert!(q.dot(p) > 0.9999, "roundtrip drift: {p:?} -> {q:?}");
        }
    }

    #[test]
    fn equal_area_cells_have_near_uniform_solid_angle() {
        let g = CubeSphere::new(16);
        let areas: Vec<f32> = g.iter_cells().map(|c| g.cell_solid_angle(c)).collect();
        let (mn, mx) = areas.iter().fold((f32::MAX, 0.0f32), |(a,b),&x|(a.min(x), b.max(x)));
        assert!(mx / mn < 1.5, "equal-area violated: {mn}..{mx}");
    }

    #[test]
    fn each_face_has_four_neighbours_and_eight_corners_are_three_way() {
        let g = CubeSphere::new(4);
        assert_eq!(g.face_neighbours(0).len(), 4);
        assert_eq!(g.corner_junctions().len(), 8);
        for j in g.corner_junctions() { assert_eq!(j.faces.len(), 3); }
    }
}
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/hayba-explorer/src-tauri && cargo test --lib cubesphere`
Expected: FAIL — `CubeSphere` undefined.

- [ ] **Step 3: Minimal implementation** — `mod.rs`:

```rust
//! Equal-area cube-sphere erosion subsystem (spec §5).
pub mod cubesphere;
```

`cubesphere.rs` (equal-area "tangent-adjusted" cube mapping — QSC-class; uniform enough for erosion):

```rust
use glam::Vec3;

#[derive(Clone, Copy, Debug)]
pub struct Cell { pub face: u8, pub i: u32, pub j: u32 }

pub struct CornerJunction { pub faces: [u8; 3] }

pub struct CubeSphere { pub n: u32 } // n×n texels per face

const FACE_NEI: [[u8;4];6] = // +X,-X,+Y,-Y,+Z,-Z adjacency (right,left,up,down)
    [[4,5,2,3],[5,4,2,3],[1,0,5,4],[1,0,4,5],[1,0,2,3],[0,1,2,3]];

fn warp(a: f32) -> f32 { (a * std::f32::consts::FRAC_PI_4).tan() } // equal-area-ish
fn unwarp(a: f32) -> f32 { a.atan() * std::f32::consts::FRAC_2_PI }

impl CubeSphere {
    pub fn new(n: u32) -> Self { Self { n } }

    pub fn face_uv_to_sphere(&self, face: u8, u: f32, v: f32) -> Vec3 {
        let a = warp(2.0*u - 1.0); let b = warp(2.0*v - 1.0);
        let d = match face {
            0 => Vec3::new( 1.0,   b,  -a),
            1 => Vec3::new(-1.0,   b,   a),
            2 => Vec3::new(  a, 1.0,  -b),
            3 => Vec3::new(  a,-1.0,   b),
            4 => Vec3::new(  a,   b, 1.0),
            _ => Vec3::new( -a,   b,-1.0),
        };
        d.normalize()
    }

    pub fn sphere_to_face_uv(&self, p: Vec3) -> (u8, f32, f32) {
        let (ax,ay,az)=(p.x.abs(),p.y.abs(),p.z.abs());
        let (face,a,b) = if ax>=ay && ax>=az {
            if p.x>0.0 {(0u8,-p.z/ax,p.y/ax)} else {(1,p.z/ax,p.y/ax)}
        } else if ay>=az {
            if p.y>0.0 {(2u8,p.x/ay,-p.z/ay)} else {(3,p.x/ay,p.z/ay)}
        } else if p.z>0.0 {(4u8,p.x/az,p.y/az)} else {(5,-p.x/az,p.y/az)};
        (face, 0.5*(unwarp(a)+1.0), 0.5*(unwarp(b)+1.0))
    }

    pub fn iter_cells(&self) -> impl Iterator<Item = Cell> + '_ {
        let n=self.n;
        (0..6u8).flat_map(move |f| (0..n).flat_map(move |j| (0..n).map(move |i| Cell{face:f,i,j})))
    }
    pub fn cell_solid_angle(&self, c: Cell) -> f32 {
        let s=1.0/self.n as f32;
        let u=(c.i as f32+0.5)*s; let v=(c.j as f32+0.5)*s;
        let p=self.face_uv_to_sphere(c.face,u,v);
        let pu=self.face_uv_to_sphere(c.face,u+s,v);
        let pv=self.face_uv_to_sphere(c.face,u,v+s);
        (pu-p).cross(pv-p).length()
    }
    pub fn face_neighbours(&self, f: u8) -> [u8;4] { FACE_NEI[f as usize] }
    pub fn corner_junctions(&self) -> Vec<CornerJunction> {
        // 8 cube corners; faces meeting at each (static topology).
        vec![
            CornerJunction{faces:[0,2,4]},CornerJunction{faces:[0,2,5]},
            CornerJunction{faces:[0,3,4]},CornerJunction{faces:[0,3,5]},
            CornerJunction{faces:[1,2,4]},CornerJunction{faces:[1,2,5]},
            CornerJunction{faces:[1,3,4]},CornerJunction{faces:[1,3,5]},
        ]
    }
}
```

Add `mod erosion;` to `lib.rs` right after `mod hydrology;`.

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/hayba-explorer/src-tauri && cargo test --lib cubesphere`
Expected: PASS (3 tests). Tune `warp`/face-basis signs only if roundtrip fails.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/erosion/mod.rs apps/hayba-explorer/src-tauri/src/erosion/cubesphere.rs apps/hayba-explorer/src-tauri/src/lib.rs
git commit -m "feat(erosion): equal-area cube-sphere grid (faces, corners, roundtrip)"
```

### Task A2: ErosionConfig + module entry

**Files:**
- Modify: `apps/hayba-explorer/src-tauri/src/erosion/mod.rs`

- [ ] **Step 1: Failing test** — in `mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_defaults_are_sane() {
        let c = ErosionConfig::default();
        assert!(c.pyramid_levels >= 4 && c.k_iters_per_level >= 8);
        assert!(c.incision_clamp > 0.0 && c.incision_clamp < 0.01);
        assert!(c.beta > 0.0 && c.beta <= 1.0);
        assert!(c.uplift == 0.0, "U MUST be 0 (spec §3): no equilibrium attractor");
    }
}
```

- [ ] **Step 2: Run, verify fails** — `cargo test --lib config_defaults` → FAIL.

- [ ] **Step 3: Implement** — prepend to `mod.rs`:

```rust
pub mod cubesphere;

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(default)]
pub struct ErosionConfig {
    pub base_face_res: u32,     // coarsest face res (e.g. 64)
    pub pyramid_levels: u32,    // ×2 steps to target (64→…→2048)
    pub k_iters_per_level: u32, // erosion iters/level (~16)
    pub erodibility: f32,       // stream-power K
    pub area_exp: f32,          // m ≈ 0.5
    pub slope_exp: f32,         // n = 1.0
    pub incision_clamp: f32,    // ε per-step (normalized)
    pub thermal_d: f32,         // hillslope diffusion
    pub talus_angle: f32,       // critical slope (rad-ish, normalized)
    pub deposition_g: f32,      // Davy-Lague G (~1.6)
    pub beta: f32,              // frequency-sep macro restore (0..1)
    pub uplift: f32,            // MUST be 0.0
    pub seed: u64,
}
impl Default for ErosionConfig {
    fn default() -> Self { Self {
        base_face_res: 64, pyramid_levels: 5, k_iters_per_level: 16,
        erodibility: 5e-5, area_exp: 0.5, slope_exp: 1.0, incision_clamp: 3e-4,
        thermal_d: 0.08, talus_angle: 0.6, deposition_g: 1.6, beta: 0.2,
        uplift: 0.0, seed: 0x9E37_79B9,
    } }
}
```

- [ ] **Step 4: Run, verify pass** — `cargo test --lib config_defaults` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/erosion/mod.rs
git commit -m "feat(erosion): ErosionConfig with U=0 invariant + serde defaults"
```

---

## Phase A1 — CPU reference oracle (deterministic TDD backbone)

> Each task: failing Rust test → minimal impl → pass → commit. All operate on
> `Field { cs: CubeSphere, h: Vec<f32>, water: Vec<f32>, sed: Vec<f32>, ocean: Vec<bool> }`
> indexed `face*n*n + j*n + i`. Add `Field` + index helpers in Task A3.

### Task A3: Cube-sphere `Field` + neighbour/halo/corner access (`pyramid.rs`)

**Files:** Create `apps/hayba-explorer/src-tauri/src/erosion/pyramid.rs`; Modify `mod.rs` (`pub mod pyramid;`).

- [ ] **Step 1: Failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn neighbour_crossing_a_face_edge_is_continuous() {
        let f = Field::flat(4, 0.5);
        // a right-edge cell on +Z must resolve its +u neighbour onto +X
        let c = (4,3,1); // (face,i,j)
        let nb = f.neighbour(c.0, c.1 as i32 + 1, c.2 as i32);
        assert_eq!(nb.0, 1u8, "+Z right edge wraps to +X face");
    }
    #[test]
    fn corner_gather_is_three_way_not_four() {
        let f = Field::flat(4, 0.0);
        let s = f.corner_neighbour_count(4, 3, 3); // a +Z far corner
        assert_eq!(s, 3, "corner has 3 neighbours");
    }
}
```

- [ ] **Step 2: Run, verify fails** — `cargo test --lib pyramid::tests::neighbour` → FAIL.

- [ ] **Step 3: Implement** — `pyramid.rs` with `Field`, `idx`, `neighbour(face,i,j)` (wraps across `FACE_NEI` with the per-edge axis swap/flip), `corner_neighbour_count` (returns 3 at the 4 face-corner texels that coincide with cube corners). Minimal but correct edge-wrap table; corner texels return 3 neighbours (drop the diagonal).

```rust
use super::cubesphere::CubeSphere;
pub struct Field { pub cs: CubeSphere, pub h: Vec<f32>, pub water: Vec<f32>,
    pub sed: Vec<f32>, pub ocean: Vec<bool> }
impl Field {
    pub fn flat(n: u32, h0: f32) -> Self {
        let len=(6*n*n) as usize;
        Self{cs:CubeSphere::new(n), h:vec![h0;len], water:vec![0.0;len],
             sed:vec![0.0;len], ocean:vec![false;len]}
    }
    #[inline] pub fn idx(&self,f:u8,i:u32,j:u32)->usize {
        (f as u32*self.cs.n*self.cs.n + j*self.cs.n + i) as usize }
    /// Resolve (face,i±,j±) across face seams. Returns destination cell.
    pub fn neighbour(&self,f:u8,i:i32,j:i32)->(u8,u32,u32){ /* edge-wrap table */ }
    pub fn corner_neighbour_count(&self,f:u8,i:u32,j:u32)->u32{ /* 3 at cube corners else 4 */ }
}
```

(Implement the edge-wrap table explicitly per `FACE_NEI` with the standard cube-face axis transforms; corner cells = the 4 (i,j)∈{0,n-1}² texels — return 3.)

- [ ] **Step 4: Run, verify pass** — `cargo test --lib pyramid::tests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/erosion/pyramid.rs apps/hayba-explorer/src-tauri/src/erosion/mod.rs
git commit -m "feat(erosion): Field + seam-correct neighbour/corner access (3-way junctions)"
```

### Task A4: Deterministic sphere-domain noise (`noise.rs`)

**Files:** Create `erosion/noise.rs`; Modify `mod.rs` (`pub mod noise;`).

- [ ] **Step 1: Failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*; use glam::Vec3;
    #[test] fn fbm_is_deterministic_and_seam_continuous() {
        let a = fbm(Vec3::new(0.3,0.4,0.5).normalize(), 5, 7);
        let b = fbm(Vec3::new(0.3,0.4,0.5).normalize(), 5, 7);
        assert_eq!(a, b, "same pos+seed → same value (determinism)");
        // continuity: tiny position delta → tiny value delta (no seam jump)
        let p = Vec3::new(1.0,1e-4,0.0).normalize();
        let q = Vec3::new(1.0,-1e-4,0.0).normalize();
        assert!((fbm(p,5,7)-fbm(q,5,7)).abs() < 0.05);
    }
    #[test] fn ridged_and_worley_in_range() {
        let p=Vec3::X;
        assert!((0.0..=1.0).contains(&ridged(p,4,1)));
        assert!((0.0..=1.0).contains(&worley(p,1)));
    }
}
```

- [ ] **Step 2: Run, verify fails** — FAIL (undefined).

- [ ] **Step 3: Implement** — `noise.rs`: a 3D value/simplex hash keyed by `seed`; `fbm(pos,octaves,seed)`, `ridged(pos,octaves,seed)`, `worley(pos,seed)`, `domain_warp(pos,seed)->Vec3`. Position-domain only. Minimal hash-noise is fine (quality tuned later/visually).

- [ ] **Step 4: Run, verify pass** — `cargo test --lib noise::tests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/erosion/noise.rs apps/hayba-explorer/src-tauri/src/erosion/mod.rs
git commit -m "feat(erosion): deterministic sphere-domain fbm/ridged/worley/domain-warp"
```

### Task A5: Rasterize painted Goldberg field → cube-sphere `h0`

**Files:** Modify `erosion/pyramid.rs` (`rasterize_from_cells`).

- [ ] **Step 1: Failing test**

```rust
#[test]
fn rasterize_samples_nearest_cell_elevation_and_flags_ocean() {
    // 2 fake cells: +Z pole land 0.5, -Z pole ocean -1.0.
    let cells = vec![(glam::Vec3::Z, 0.5f32), (glam::Vec3::NEG_Z, -1.0)];
    let f = rasterize_from_cells(8, &cells);
    let zc = f.idx(4, 4, 4); // mid +Z face
    assert!((f.h[zc] - 0.5).abs() < 1e-3 && !f.ocean[zc]);
    let nc = f.idx(5, 4, 4); // mid -Z face
    assert!(f.h[nc] < 0.0 && f.ocean[nc]);
}
```

- [ ] **Step 2: Run, verify fails** — FAIL.

- [ ] **Step 3: Implement** `rasterize_from_cells(n, cells: &[(Vec3,f32)]) -> Field`: for each face texel, sphere pos → nearest input cell (brute force for the test; production path passes the existing grid's kd-tree — Task A11 wires the real source). `ocean = h < 0.0`.

- [ ] **Step 4: Run, verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/erosion/pyramid.rs
git commit -m "feat(erosion): rasterize painted cells onto cube-sphere h0 + ocean mask"
```

### Task A6: Detail-band injection

**Files:** Modify `erosion/pyramid.rs` (`inject_detail_band`).

- [ ] **Step 1: Failing test**

```rust
#[test]
fn detail_band_adds_zero_mean_seam_continuous_relief_scaled_by_slope() {
    let mut f = Field::flat(16, 0.5);
    let before = f.h.clone();
    inject_detail_band(&mut f, /*level*/2, /*amp*/0.05, /*seed*/7, /*slope*/&vec![1.0; f.h.len()]);
    let mean: f32 = f.h.iter().zip(&before).map(|(a,b)| a-b).sum::<f32>() / f.h.len() as f32;
    assert!(mean.abs() < 5e-3, "near zero-mean (adds detail, not bias)");
    assert!(f.h.iter().zip(&before).any(|(a,b)| (a-b).abs() > 1e-4), "did add relief");
    assert!(f.h.iter().all(|v| v.is_finite()));
}
```

- [ ] **Step 2: Run, verify fails** — FAIL.

- [ ] **Step 3: Implement** `inject_detail_band(&mut Field, level, amp, seed, slope01)`: per land texel, `h += amp * slope01[k] * (fbm(pos, level+2, seed)*2-1)` blended with `ridged` where slope high. Ocean untouched. Frequency scales with `level`.

- [ ] **Step 4: Run, verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/erosion/pyramid.rs
git commit -m "feat(erosion): seam-continuous detail-band injection (slope-modulated)"
```

### Task A7: Stream-power incision step (U=0, ε-clamped)

**Files:** Modify `erosion/pyramid.rs` (`stream_power_step`). Reuse the proven math shape from `hydrology.rs`.

- [ ] **Step 1: Failing test**

```rust
#[test]
fn stream_power_incises_channels_clamped_and_never_below_receiver() {
    // monotone ramp on one face → flow downhill, incise, no inversion.
    let n=8; let mut f=Field::flat(n,0.0);
    for j in 0..n { for i in 0..n {
        let k=f.idx(4,i,j); f.h[k]= j as f32 * 0.1; }} // rises with j
    f.ocean.iter_mut().for_each(|o|*o=false);
    let h0=f.h.clone();
    let cfg=super::ErosionConfig{ incision_clamp:1e-3, ..Default::default()};
    stream_power_step(&mut f,&cfg);
    for k in 0..f.h.len() {
        assert!(f.h[k] <= h0[k] + 1e-6, "U=0 ⇒ only lowers");
        assert!(h0[k]-f.h[k] <= 1e-3 + 1e-6, "per-step incision clamp ε respected");
        assert!(f.h[k].is_finite(), "no NaN/inf (incl. at cube corners)");
    }
}

#[test]
fn stream_power_slope_at_cube_corner_is_finite() {
    // The 8 cube corners are 3-way junctions; a naïve dx/dy gradient there
    // collapses → NaN/∞. Put relief straddling a +Z corner and assert finite.
    let n=8; let mut f=Field::flat(n,0.0);
    for j in 0..n { for i in 0..n { let k=f.idx(4,i,j);
        f.h[k]= (i+j) as f32 * 0.05; }}
    f.ocean.iter_mut().for_each(|o|*o=false);
    let cfg=super::ErosionConfig::default();
    stream_power_step(&mut f,&cfg);
    let corner=f.idx(4,n-1,n-1);
    assert!(f.h[corner].is_finite(), "corner slope must use the 3-vertex plane fit");
}
```

- [ ] **Step 2: Run, verify fails** — FAIL.

- [ ] **Step 3: Implement** `stream_power_step`: per land cell find steepest-descent receiver via `neighbour` (great-circle distance from `face_uv_to_sphere`), single-flow drainage accumulation (topological by elevation, Braun–Willett O(N) like `hydrology::drainage_area`), `dz = -(K·A^m·S^n)`, clamp `|dz| ≤ ε`, never below receiver, never below 0. `U=0`.
  **HARDENING — 3-way corner gradient (NORMATIVE):** the 4 face-corner texels that coincide with the 8 cube corners have only 3 neighbours; the standard symmetric finite-difference dx/dy collapses there (NaN/∞ slope). Add a dedicated branch: when `corner_neighbour_count==3`, compute slope/receiver from the **least-squares plane through the 3 available adjacent vertices** (their sphere positions + heights), not the axis-aligned difference. Same exception is reused by A8.

- [ ] **Step 4: Run, verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/erosion/pyramid.rs
git commit -m "feat(erosion): U=0 ε-clamped stream-power incision on cube-sphere"
```

### Task A8: Talus-clamped thermal diffusion (finite-volume)

**Files:** Modify `erosion/pyramid.rs` (`thermal_step`).

- [ ] **Step 1: Failing test**

```rust
#[test]
fn thermal_relaxes_oversteep_slopes_only_and_is_mass_conserving() {
    let n=8; let mut f=Field::flat(n,0.0);
    let kc=f.idx(4,4,4); f.h[kc]=1.0;            // a spike steeper than talus
    let kf=f.idx(4,1,1); f.h[kf]=0.001;          // gentle ≪ talus
    f.ocean.iter_mut().for_each(|o|*o=false);
    let before_flat=f.h[kf];
    let sum0:f32=f.h.iter().sum();
    let cfg=super::ErosionConfig::default();
    thermal_step(&mut f,&cfg);
    assert!(f.h[kc] < 1.0, "oversteep spike relaxed");
    assert!((f.h[kf]-before_flat).abs() < 1e-7, "gentle slope untouched (talus clamp)");
    assert!((f.h.iter().sum::<f32>()-sum0).abs() < 1e-3, "diffusion conserves mass");
    assert!(f.h.iter().all(|v| v.is_finite()), "no NaN at the 8 cube corners");
}
```

- [ ] **Step 2: Run, verify fails** — FAIL.

- [ ] **Step 3: Implement** finite-volume Laplacian over `neighbour`s with `D(S)=0 if S<talus else D·(1−talus/S)`; symmetric flux (mass-conserving); CFL-safe (clamp effective `D·dt`).
  **HARDENING — 3-way corner Laplacian (NORMATIVE):** at the 8 cube-corner texels (`corner_neighbour_count==3`) the finite-volume Laplacian must sum over **only the 3 real neighbour fluxes** (the missing 4th is not zero-filled — zero-filling injects a phantom flux). Reuse the A7 3-vertex plane-fit for the slope term feeding `D(S)`. Verified by the corner-finiteness assertion above.

- [ ] **Step 4: Run, verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/erosion/pyramid.rs
git commit -m "feat(erosion): talus-clamped mass-conserving thermal diffusion"
```

### Task A9: Mass-conserving ×2 upsample

**Files:** Modify `erosion/pyramid.rs` (`upsample2x`).

- [ ] **Step 1: Failing test** (the §5.4 HARDENING invariant)

```rust
#[test]
fn upsample_conserves_water_and_sediment_exactly() {
    let mut f=Field::flat(4,0.3);
    for k in 0..f.water.len(){ f.water[k]=0.4; f.sed[k]=0.2; }
    let sum_w0:f32=f.water.iter().sum();
    let g=upsample2x(&f);
    assert_eq!(g.cs.n, 8);
    // per coarse texel: Σ of its 4 fine children == coarse value
    let kc=f.idx(4,1,1);
    let mut acc=0.0; for (di,dj) in [(0,0),(1,0),(0,1),(1,1)] {
        acc += g.water[g.idx(4,2*1+di,2*1+dj)]; }
    assert!((acc - f.water[kc]).abs() < 1e-6, "Σ d_fine == d_coarse");
    assert!((g.water.iter().sum::<f32>()-sum_w0).abs() < 1e-4, "global water conserved");
}

#[test]
fn upsample_h_introduces_no_spurious_pits() {
    // A coarse strictly-monotone valley; bilinear h alone manufactures
    // local minima between coarse samples → conserved water would pool
    // there and break rivers. Post-fill must keep a downhill path.
    let n=4; let mut f=Field::flat(n,0.0);
    for j in 0..n { for i in 0..n { let k=f.idx(4,i,j);
        f.h[k]= 1.0 - j as f32 * 0.2; }} // strictly descends in +j
    f.ocean.iter_mut().for_each(|o|*o=false);
    let g=upsample2x(&f);
    // every fine land cell (except the global min) has a strictly-lower neighbour
    for j in 0..g.cs.n-1 { for i in 0..g.cs.n {
        let k=g.idx(4,i,j);
        let down=g.idx(4,i,j+1);
        assert!(g.h[down] <= g.h[k] + 1e-6, "no upstream-facing pit after upsample fill");
    }}
}
```

- [ ] **Step 2: Run, verify fails** — FAIL.

- [ ] **Step 3: Implement** `upsample2x`: `h` bilinear; `water`/`sed` split so each coarse texel's value is distributed area-weighted across its 4 children with exact sum preservation (`child = parent * area_child/area_parent`, areas from `cell_solid_angle`; for ~uniform cells ≈ parent/4).
  **HARDENING — post-upsample pit removal (NORMATIVE):** bilinear `h` of a coarse valley manufactures artificial local minima between coarse samples; the (correctly) conserved water then pools in those phantom pits on the next iteration and severs river networks. After bilinear `h` and **before** the carried `water`/`sed` are placed, run a **fast local depression-fill / monotonic-downhill enforcement** on the new fine `h` (a few Priority-Flood-lite sweeps on land texels, ocean fixed) so every fine land cell retains a strictly-downhill path. Order is mandatory: upsample h → pit-fill h → apply conserved water/sed.

- [ ] **Step 4: Run, verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/erosion/pyramid.rs
git commit -m "feat(erosion): mass-conserving area-weighted x2 upsample (Σd_fine=d_coarse)"
```

### Task A10: Pyramid driver + frequency-separation macro blend

**Files:** Modify `erosion/pyramid.rs` (`run_pyramid`).

- [ ] **Step 1: Failing test**

```rust
#[test]
fn pyramid_adds_detail_but_preserves_macro_shape() {
    // smooth dome macro on +Z; after erosion the LOW-PASS must match h0,
    // while high-freq variance must increase (detail added).
    let n0=8; let mut src=Field::flat(n0,0.0);
    for j in 0..n0 { for i in 0..n0 {
        let k=src.idx(4,i,j);
        src.h[k]= 0.6 - 0.02*(((i as f32-3.5).powi(2)+(j as f32-3.5).powi(2))); }}
    src.ocean.iter_mut().for_each(|o|*o=false);
    let cfg=super::ErosionConfig{ base_face_res:n0, pyramid_levels:3, beta:0.2, ..Default::default()};
    let out=run_pyramid(&src,&cfg);                 // returns finest Field
    let macro_err = lowpass_l2_diff(&out, &src);    // helper: compare low-freq bands
    assert!(macro_err < 0.05, "macro relief preserved (frequency-sep)");
    assert!(highfreq_energy(&out) > highfreq_energy_upsampled(&src), "detail added");
    assert!(out.h.iter().all(|v| v.is_finite()));
}
```

(Add small private helpers `lowpass_l2_diff`, `highfreq_energy*` under `#[cfg(test)]`.)

- [ ] **Step 2: Run, verify fails** — FAIL.

- [ ] **Step 3: Implement** `run_pyramid`: from `base_face_res`, per level `{ inject_detail_band → for k in K { stream_power_step; thermal_step; deposition (Davy-Lague G) } → upsample2x }`; after the loop `h_final = h_eroded + beta*(h0_resampled_to_final - lowpass(h_eroded))`. `lowpass` = separable box/gaussian over `neighbour`s sized to `base` scale. Deposition: add the transport-limited term `+ G·Qs/A` (sediment carried downstream, deposited where capacity drops).

- [ ] **Step 4: Run, verify pass** — PASS (tune `beta`/kernel only to satisfy the macro-preservation assertion).

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/erosion/pyramid.rs
git commit -m "feat(erosion): multi-scale pyramid driver + frequency-separation macro preserve"
```

### Task A11: cube-sphere → equirect resample + `bake_erode_v2` command

**Files:** Create `erosion/resample.rs`; Modify `erosion/mod.rs`, `wizard.rs`, `lib.rs`.

- [ ] **Step 1: Failing tests** — `resample.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn equirect_is_seam_continuous_in_longitude() {
        let f = super::super::pyramid::Field::flat(16, 0.5);
        let eq = cubesphere_to_equirect(&f, 64, 32);
        for y in 0..32 { // u=0 and u=1 (±180°) sample the same meridian
            assert!((eq[(y*64) as usize] - eq[(y*64+63) as usize]).abs() < 0.05);
        }
    }
}
```

and in `wizard.rs` tests:

```rust
#[test]
fn bake_erode_v2_returns_equirect_h_final_for_a_painted_draft() {
    let mut d = draft_for("plates2");
    d.continental_cells = (0..2000).collect();
    let r = bake_erode_v2_impl(&d, &crate::erosion::ErosionConfig{
        base_face_res:32, pyramid_levels:3, ..Default::default()});
    assert_eq!(r.equirect_w * r.equirect_h, r.h_final.len() as u32);
    assert!(r.h_final.iter().all(|v| v.is_finite()));
    assert!(r.h_final.iter().any(|&v| v > 0.0), "has land");
}
```

- [ ] **Step 2: Run, verify fails** — `cargo test --lib resample` and `bake_erode_v2` → FAIL.

- [ ] **Step 3: Implement**
  - `resample.rs`: `cubesphere_to_equirect(&Field, w, h) -> Vec<f32>` — per equirect texel `(lon,lat)`→sphere pos→`sphere_to_face_uv`→bilinear fetch. U-wrap, V-clamp.
  - `mod.rs`: `pub mod resample;` + `pub fn bake_erode_cpu(src:&Field,cfg:&ErosionConfig,(w,h):(u32,u32)) -> Vec<f32>` = `run_pyramid` then `cubesphere_to_equirect`.
  - `wizard.rs`: `pub(crate) fn bake_erode_v2_impl(draft:&WizardDraft,cfg:&ErosionConfig)->ErodeResultV2` — build painted `(Vec3,f32)` cells from the draft like `bake_impl` does (continental brush / painted arrays / deep-ocean floor), `rasterize_from_cells`, `bake_erode_cpu` at 8192×4096 (test uses small res via cfg). `#[derive(serde::Serialize)] pub struct ErodeResultV2 { pub equirect_w:u32, pub equirect_h:u32, pub h_final: Vec<f32> }`. Add `#[tauri::command] pub fn bake_erode_v2(draft:WizardDraft, erosion_config:Option<crate::erosion::ErosionConfig>) -> ErodeResultV2`.
  - `lib.rs`: add `wizard::bake_erode_v2` to `generate_handler![]`.

- [ ] **Step 4: Run, verify pass** — both tests PASS. Also run full suite: `cargo test --lib` (expect all green, no regressions).

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/erosion/resample.rs apps/hayba-explorer/src-tauri/src/erosion/mod.rs apps/hayba-explorer/src-tauri/src/wizard.rs apps/hayba-explorer/src-tauri/src/lib.rs
git commit -m "feat(erosion): cube→equirect resample + bake_erode_v2 command (CPU oracle complete)"
```

**Milestone:** the CPU oracle is now a complete, deterministic, fully-tested erosion bake. Phase A2 ports it to GPU; correctness = parity vs this.

---

## Phase A2 — GPU port (Three.js WebGL2 ping-pong)

> No headless-WebGL test runner exists. Each GPU task: implement → wire into the
> parity harness (A20) and/or visual checklist (A23) → commit. TS *logic* (no GL)
> still gets `npx tsx` tests where applicable.

### Task A12: RGBA32F ping-pong framework + float-support guard

**Files:** Create `src/viewport/bake/pingpong.ts`, `src/viewport/bake/pingpong.test.ts`.

- [ ] **Step 1: Failing test** (`pingpong.test.ts` — pure swap logic, no GL):

```ts
// Run: npx tsx src/viewport/bake/pingpong.test.ts
import assert from "node:assert/strict";
import { PingPongBook } from "./pingpong";
const bk = new PingPongBook(["h","water","sed"]);
assert.equal(bk.read("h"), 0);
bk.swap("h"); assert.equal(bk.read("h"), 1);
bk.swap("h"); assert.equal(bk.read("h"), 0);
assert.equal(bk.read("water"), 0, "channels swap independently");
console.log("ok");
```

- [ ] **Step 2: Run, verify fails** — `cd apps/hayba-explorer && npx tsx src/viewport/bake/pingpong.test.ts` → FAIL.

- [ ] **Step 3: Implement** `pingpong.ts`: `PingPongBook` (per-channel read/write index bookkeeping — testable logic) **and** `createPingPong(renderer, w, h, channels)` that allocates paired `THREE.WebGLRenderTarget` (`type: THREE.FloatType`, `format: THREE.RGBAFormat`), throws a clear `Error("RGBA32F render targets unsupported (EXT_color_buffer_float)")` if `renderer.getContext().getExtension("EXT_color_buffer_float")` is null, and a `runPass(fragmentShader, uniforms, outChannel)` fullscreen-quad helper (orthographic quad scene, render to the write RT, then `book.swap`).
  **HARDENING — float-linear trap (NORMATIVE):** `EXT_color_buffer_float` only enables *rendering* to float; it does **not** guarantee hardware **bilinear** sampling of float textures (`OES_texture_float_linear`, missing on some Apple-Silicon/mobile). If absent, `linearFilter` silently degrades to nearest → stair-stepped rivers in the upsample/resample. Implement: probe `getExtension("OES_texture_float_linear")`; export a boolean `FLOAT_LINEAR_OK`. If true, RTs use `THREE.LinearFilter`; if false, RTs use `THREE.NearestFilter` **and** A14's upsample + A19's resample shaders take a `uManualBilinear` define and do an explicit **4-tap bilinear** in GLSL. The framework must expose `FLOAT_LINEAR_OK` so A14/A15/A19 select the path. Add a `pingpong.test.ts` assertion that `createPingPong` (when given a fake ctx whose `getExtension` returns null for `OES_texture_float_linear`) sets `manualBilinear===true`.

- [ ] **Step 4: Run, verify pass** — tsx test PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/viewport/bake/pingpong.ts apps/hayba-explorer/src/viewport/bake/pingpong.test.ts
git commit -m "feat(bake): RGBA32F ping-pong framework + float-support hard guard"
```

### Task A13: TS cube-sphere mirror + parity test vs Rust

**Files:** Create `src/viewport/bake/cubesphere.ts`, `src/viewport/bake/cubesphere.test.ts`.

- [ ] **Step 1: Failing test**

```ts
// Run: npx tsx src/viewport/bake/cubesphere.test.ts
import assert from "node:assert/strict";
import { sphereToFaceUv, faceUvToSphere } from "./cubesphere";
const p = [0.3,0.7,-0.2]; const n=Math.hypot(...p);
const u=[p[0]/n,p[1]/n,p[2]/n] as [number,number,number];
const {face,u:fu,v:fv}=sphereToFaceUv(u);
const q=faceUvToSphere(face,fu,fv);
assert.ok(q[0]*u[0]+q[1]*u[1]+q[2]*u[2] > 0.9999, "roundtrip");
console.log("ok");
```

- [ ] **Step 2: Run, verify fails** — FAIL.

- [ ] **Step 3: Implement** `cubesphere.ts` as an exact port of `cubesphere.rs` (`warp`/`unwarp`, `FACE_NEI`, `sphereToFaceUv`, `faceUvToSphere`). Keep formulas byte-identical so GPU == CPU.

- [ ] **Step 4: Run, verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/viewport/bake/cubesphere.ts apps/hayba-explorer/src/viewport/bake/cubesphere.test.ts
git commit -m "feat(bake): TS cube-sphere mirror (formula-identical to Rust oracle)"
```

### Task A14: GLSL pass library (noise, stream-power, thermal, upsample, resample)

**Files:** Create `src/viewport/bake/passes.glsl.ts`.

- [ ] **Step 1: (No unit test — GLSL.)** Add a `passes.glsl.test.ts` that only asserts the exported strings compile-shape (contain `void main`, no backticks-in-comments — the known `.glsl.ts` footgun):

```ts
// Run: npx tsx src/viewport/bake/passes.glsl.test.ts
import assert from "node:assert/strict";
import * as P from "./passes.glsl";
for (const [k,v] of Object.entries(P)) {
  assert.ok(typeof v==="string" && v.includes("void main"), `${k} is a shader`);
  assert.ok(!v.includes("`"), `${k}: no backtick in GLSL (breaks template literal)`);
}
console.log("ok");
```

- [ ] **Step 2: Run, verify fails** — FAIL (module missing).

- [ ] **Step 3: Implement** `passes.glsl.ts` exporting GLSL ES 3.0 fragment strings, each a faithful port of the corresponding Rust function (A4/A6/A7/A8/A9 + resample A11), operating on a **6-faces-in-one-2D-atlas** layout (faces tiled 3×2). Include a shared `vec3 faceTexelToSpherePos(...)` and seam/corner-correct `neighbourTexel(...)` chunk mirroring `Field::neighbour`/corner rules. Also include these shared chunks (consumed by the upsample + resample passes):
  - `vec4 tap2D(sampler2D t, vec2 uv, vec2 texel)` — explicit **4-tap manual bilinear**, compiled in when `uManualBilinear` is set (the `OES_texture_float_linear` fallback from A12). All upsample/resample fetches go through `tap2D` (it reduces to a single `texture()` when manual bilinear is off).
  - `cornerSlope3(...)` — the **3-vertex plane-fit** slope used by the stream-power (A7) and thermal (A8) ports at the 8 cube corners (`neighbourCount==3`); never the symmetric difference there.
  - `fillPits(...)` — the post-bilinear monotonic-downhill enforcement (A9 HARDENING) applied to `h` before the conserved water/sed are placed in the upsample pass.

- [ ] **Step 4: Run, verify pass** — tsx shape-test PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/viewport/bake/passes.glsl.ts apps/hayba-explorer/src/viewport/bake/passes.glsl.test.ts
git commit -m "feat(bake): GLSL pass library (ports of CPU oracle steps)"
```

### Task A15: GPU pyramid orchestrator → equirect `h_final` texture

**Files:** Create `src/viewport/bake/erodePipeline.ts`; Modify `src/viewport/scene.ts` (add `runBake`).

- [ ] **Step 1: (No GL unit test.)** tsx test for the level-schedule logic only:

```ts
// Run: npx tsx src/viewport/bake/erodePipeline.test.ts
import assert from "node:assert/strict";
import { pyramidSchedule } from "./erodePipeline";
const s = pyramidSchedule({ baseFaceRes:64, pyramidLevels:5 } as any);
assert.deepEqual(s.map(x=>x.faceRes), [64,128,256,512,1024]);
console.log("ok");
```

- [ ] **Step 2: Run, verify fails** — FAIL.

- [ ] **Step 3: Implement** `erodePipeline.ts`: `pyramidSchedule(cfg)` (pure, tested) + `runErodeBake(renderer, srcH0Tex, cfg, onProgress) -> THREE.Texture` that executes the schedule via `pingpong` + `passes.glsl` (inject→K×{streamPower,thermal,deposition}→upsample), then frequency-sep blend, then the resample pass producing an 8K equirect Float texture. `scene.ts`: add `runBake(fn)` to the returned handle that cancels `tick`'s `raf`, runs `fn(renderer)`, then resumes — keeps the bake off the live loop ("bake-then-watch").

- [ ] **Step 4: Run, verify pass** — tsx schedule test PASS. Build check: `cd apps/hayba-explorer && npx tsc -b` (no type errors).

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/viewport/bake/erodePipeline.ts apps/hayba-explorer/src/viewport/bake/erodePipeline.test.ts apps/hayba-explorer/src/viewport/scene.ts
git commit -m "feat(bake): GPU multi-scale pyramid orchestrator → equirect h_final"
```

### Task A16: Source `h0` upload (Rust rasterize → GPU texture)

**Files:** Modify `wizard.rs` (`bake_h0_v2` returning the cube-sphere atlas), `lib.rs`; Create `src/viewport/bake/uploadH0.ts`.

- [ ] **Step 1: Failing Rust test**

```rust
#[test]
fn bake_h0_v2_returns_cube_atlas_sized_correctly() {
    let d = draft_for("plates2");
    let a = bake_h0_v2_impl(&d, 64);
    assert_eq!(a.face_res, 64);
    assert_eq!(a.atlas.len(), (6*64*64) as usize);
    assert!(a.atlas.iter().all(|v| v.is_finite()));
}
```

- [ ] **Step 2: Run, verify fails** — FAIL.

- [ ] **Step 3: Implement** `bake_h0_v2_impl(draft, face_res) -> H0Atlas { face_res:u32, atlas:Vec<f32> }` (reuse Task A11's painted-cell construction + `rasterize_from_cells`, serialize the 6-face atlas). `#[tauri::command] bake_h0_v2`. Register in `lib.rs`. `uploadH0.ts`: turn the atlas `number[]` into a `THREE.DataTexture` (`FloatType`, 3×2 face layout) for `runErodeBake`.

- [ ] **Step 4: Run, verify pass** — `cargo test --lib bake_h0_v2` PASS; `npx tsc -b` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/wizard.rs apps/hayba-explorer/src-tauri/src/lib.rs apps/hayba-explorer/src/viewport/bake/uploadH0.ts
git commit -m "feat(bake): Rust rasterize → cube-sphere h0 atlas → GPU DataTexture"
```

### Task A17: Debug relief material + map-mode wiring

**Files:** Create `src/viewport/bake/debugMaterial.ts`; Modify `src/App.tsx`.

- [ ] **Step 1: (Visual task — no unit test.)** tsx test that the material factory returns a `THREE.ShaderMaterial` with a `uHeight` uniform:

```ts
// Run: npx tsx src/viewport/bake/debugMaterial.test.ts
import assert from "node:assert/strict";
import { makeDebugReliefMaterial } from "./debugMaterial";
const m = makeDebugReliefMaterial();
assert.ok(m.uniforms.uHeight && "value" in m.uniforms.uHeight);
console.log("ok");
```

- [ ] **Step 2: Run, verify fails** — FAIL.

- [ ] **Step 3: Implement** `makeDebugReliefMaterial()`: a sphere `ShaderMaterial` mapping vertex → equirect uv (`u=atan2(z,x)`, `v=asin(y)`), sampling `uHeight` (the `h_final` equirect texture) as shaded relief (hypsometric ramp + `dFdx/dFdy` slope shading). `App.tsx`: behind the existing bake button, call `bake_h0_v2` → upload → `scene.runBake(r => runErodeBake(...))` → set the result texture on a debug globe via `setGlobe(new THREE.Mesh(sphere, debugMat))`; add a map-mode toggle h0 vs h_final.

- [ ] **Step 4: Run, verify pass** — tsx PASS; `npx tsc -b` clean; `npm run build` succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/viewport/bake/debugMaterial.ts apps/hayba-explorer/src/viewport/bake/debugMaterial.test.ts apps/hayba-explorer/src/App.tsx
git commit -m "feat(bake): equirect relief debug material + bake-button wiring"
```

---

## Phase A3 — Parity & validation

### Task A18: CPU↔GPU parity harness

**Files:** Create `src/viewport/bake/parity.ts`; Modify `App.tsx` (dev-only "Run parity" action).

- [ ] **Step 1: Define the check** (no tsx unit test — needs GL + Tauri). Acceptance encoded as an in-app assertion.

- [ ] **Step 2: Implement** `parity.ts`: at a small res (e.g. `base_face_res:32, pyramid_levels:2`, fixed `seed`), call `bake_erode_v2` (CPU) and `runErodeBake` (GPU) on the same draft+config; read GPU back via `renderer.readRenderTargetPixels`; compute max abs and RMSE over land texels. Log a table; flag `PASS` if `RMSE < 2e-3` and `maxAbs < 2e-2` (tolerance for f32 vs CPU ordering), else `FAIL` with the worst texels.

- [ ] **Step 3: Run it** (manual, dev): trigger from the App dev action against `draft_for("plates2")`-equivalent and the Earth template. Record numbers in the commit message.

- [ ] **Step 4: If FAIL** — diff the offending pass (most likely seam/corner handling or noise formula drift); fix the GLSL to match the Rust formula exactly; re-run. Do not proceed until PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/viewport/bake/parity.ts apps/hayba-explorer/src/App.tsx
git commit -m "test(bake): CPU↔GPU parity harness (RMSE<2e-3) — passing"
```

### Task A19: Visual validation pass (Earth + painted; seams/corners/high-lat)

**Files:** None (validation); may add notes to the spec.

- [ ] **Step 1:** Load the Earth-DEM template (`src/wizard/earth-template.ts`), bake at full 8K. Screenshot globe at: equator, both poles, all 8 cube corners, the ±180° meridian.
- [ ] **Step 2:** Verify against the §12 risks: (a) no sediment pooling on the 8 corners (A1.2), (b) no fluid discontinuity / drainage break at pyramid level seams (A1.1), (c) macro relief recognizably Earth (continents/Himalaya/Amazon intact — frequency-sep working), (d) dendritic valley networks present and continuous across faces, (e) no pole artefacts.
- [ ] **Step 3:** Paint a synthetic continent; bake; confirm detail is added (not the old "distance-into-continent") and macro shape = painted shape.
- [ ] **Step 4:** Per standing project rule, validate **visually**, not by metric counts. If any risk fails, file a fix task before declaring A done.
- [ ] **Step 5: Commit** (validation notes only, if any):

```bash
git add docs/superpowers/specs/2026-05-15-baking-pipeline-redesign-design.md
git commit -m "docs(bake): Subsystem A visual-validation results + sign-off"
```

---

## Self-Review (run before declaring the plan done)

**Spec coverage:** §5.1 cube-sphere+corners → A1,A3,A14; §5.2 rasterize → A5,A11,A16; §5.3 C_proxy → *deferred:* the orographic proxy steers detail amplitude; A6 takes a `slope01` input as the hook — **add note:** wire real `C_proxy` in Subsystem B (climate) and feed it into A6 then (A6's signature already accepts a per-texel modulation array). §5.4 pyramid/detail/erode/thermal/conservative-upsample → A6,A7,A8,A9,A10 (incl. A1.1 hardening in A9, U=0 in A2/A7, ε-clamp A7); §5.5 frequency-sep → A10; §5.6 resample → A11; §5.7 bake-UX/oracle/determinism → A11 (oracle), A15 (`runBake`/bake-then-watch), seeds throughout; §11 testing → CPU oracle TDD + A18 parity + A19 visual; §12 risks 6/7/8 → A3/A14 (corners), A9 (conservative upsample), A7/A10 (no naïve flood — stream-power is O(N) Braun–Willett, hierarchical by construction). **Gap noted & assigned:** C_proxy is computed by Subsystem B's *isolated* `compute_cproxy(h0)` and evaluated on the **pre-erosion macro `h0`** (spec §5.3), then passed into A6 *before* the pyramid runs — it is NOT derived from `h_final` (that would be circular: A needs C_proxy to erode). A6 is built C_proxy-ready (per-texel modulation array).

**Hardening folded in (from architecture review):** (i) A12/A14 — `OES_texture_float_linear` is probed separately from `EXT_color_buffer_float`; absent ⇒ `NearestFilter` RTs + explicit 4-tap `tap2D` manual bilinear in the upsample/resample GLSL (silent nearest-fallback would stair-step rivers). (ii) A7/A8/A14 — the 8 three-way cube corners use a 3-vertex plane-fit slope/Laplacian (`cornerSlope3`), never the symmetric finite difference (which NaNs there); corner tests assert finiteness. (iii) A9/A14 — after bilinear-upsampling `h`, a `fillPits` monotonic-downhill pass runs **before** the conserved water/sed are placed, or the conserved water pools in bilinear-manufactured phantom pits and severs rivers.

**Placeholder scan:** GLSL bodies in A14 are specified as "faithful port of the named Rust function" with the exact source enumerated (A4/A6/A7/A8/A9/A11) and a compile-shape test — not a TODO. The Rust `neighbour` edge-wrap table (A3) is described as "explicit per `FACE_NEI` with standard cube-face axis transforms"; acceptable (concrete, test-pinned) but the implementer must fill the 24-entry table — flagged here, test `neighbour_crossing_a_face_edge_is_continuous` pins it.

**Type consistency:** `Field`, `CubeSphere`, `ErosionConfig`, `ErodeResultV2`, `H0Atlas`, `PingPongBook`, `runErodeBake`, `pyramidSchedule` names are used identically across tasks. `bake_erode_v2`/`bake_h0_v2` both registered in `lib.rs`. `seed:u64`, normalized `[-1,1]` elevation, `(face,i,j)` indexing consistent.

**Scope:** This plan is **Subsystem A only** (per umbrella §12 build order A→B→C→D). B (mask library incl. real C_proxy), C (SatMap shading), D (renderer quality) each get their own plan after A is visually signed off.

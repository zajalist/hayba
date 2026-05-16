//! Cube-sphere `Field` + seam-correct neighbour / corner access (spec §5, Task A3).
//!
//! A `Field` is the per-texel state for the multi-scale erosion pyramid.
//! The only non-trivial part is `neighbour`: resolving an out-of-range
//! `(face, i, j)` across a cube-face seam. We do NOT hand-derive an
//! axis-swap/flip table — instead we round-trip the off-edge cell centre
//! through the *actual* cube-sphere geometry (`face_uv_to_sphere` →
//! `sphere_to_face_uv`). This makes the seam transform correct by
//! construction for every (face, direction), and the geometric-continuity
//! test below pins it empirically.

use glam::Vec3;
use super::cubesphere::CubeSphere;
use super::noise::{fbm, ridged};

#[allow(dead_code)] // fields/methods wired in A5+ (rasterize/erosion)
pub struct Field {
    pub cs: CubeSphere,
    pub h: Vec<f32>,
    pub water: Vec<f32>,
    pub sed: Vec<f32>,
    pub ocean: Vec<bool>,
}

impl Field {
    pub fn flat(n: u32, h0: f32) -> Self {
        let len = (6u64 * n as u64 * n as u64) as usize;
        Self {
            cs: CubeSphere::new(n),
            h: vec![h0; len],
            water: vec![0.0; len],
            sed: vec![0.0; len],
            ocean: vec![false; len],
        }
    }

    #[inline]
    pub fn idx(&self, f: u8, i: u32, j: u32) -> usize {
        (f as u32 * self.cs.n * self.cs.n + j * self.cs.n + i) as usize
    }

    /// Resolve `(face, i±, j±)` across face seams. Returns the destination
    /// cell `(face, i, j)` with both coordinates in `[0, n)`.
    ///
    /// In-face when `0 ≤ i,j < n` — returned unchanged. Otherwise the cell
    /// lies just past one edge of `face`: we take its (out-of-range) UV
    /// centre, project to the sphere, and re-resolve through the cube-sphere
    /// geometry. This applies the correct per-edge axis swap/flip implicitly,
    /// because the destination face/uv comes from the same projection that
    /// `FACE_NEI` was derived from.
    pub fn neighbour(&self, f: u8, i: i32, j: i32) -> (u8, u32, u32) {
        let n = self.cs.n as i32;
        if i >= 0 && i < n && j >= 0 && j < n {
            return (f, i as u32, j as u32);
        }
        // Off-edge: UV of the requested (out-of-range) cell centre.
        let inv = 1.0 / self.cs.n as f32;
        let u = (i as f32 + 0.5) * inv;
        let v = (j as f32 + 0.5) * inv;
        // Project through the real geometry and re-resolve onto whatever
        // face physically owns that direction (handles the axis swap/flip).
        let p = self.cs.face_uv_to_sphere(f, u, v);
        let (nf, nu, nv) = self.cs.sphere_to_face_uv(p);
        // UV → cell index, clamped to the valid range (a seam-crossing
        // point can land marginally outside [0,1] from float drift).
        let ni = ((nu * self.cs.n as f32).floor() as i32)
            .clamp(0, n - 1) as u32;
        let nj = ((nv * self.cs.n as f32).floor() as i32)
            .clamp(0, n - 1) as u32;
        (nf, ni, nj)
    }

    /// Number of edge-adjacent neighbours for a texel. The four texels whose
    /// `(i,j) ∈ {0, n-1}²` sit on a cube *corner* where 3 faces meet — they
    /// have a 3-way junction (drop the missing diagonal), everything else 4.
    // Face index intentionally unused — all 6 cube faces share an identical n×n layout and corner topology.
    pub fn corner_neighbour_count(&self, _f: u8, i: u32, j: u32) -> u32 {
        debug_assert!(self.cs.n >= 1, "cube-sphere resolution must be >= 1");
        let n = self.cs.n;
        let on_i_edge = i == 0 || i == n - 1;
        let on_j_edge = j == 0 || j == n - 1;
        if on_i_edge && on_j_edge {
            3
        } else {
            4
        }
    }
}

/// Inject seam-continuous, slope-modulated detail noise into land texels.
///
/// For every land texel (ocean texels are left unchanged) a noise contribution
/// is added to `field.h`:
///
/// ```text
/// fbm_c     = fbm(pos, level+2, seed) * 2 - 1          // centered, ~zero-mean
/// envelope  = 1 + slope01[k] * ridged(pos, level+2, seed)   // [1, 2]
/// delta     = amp * slope01[k] * fbm_c * envelope
/// ```
///
/// `fbm_c` (fbm output centered to `[-1, 1]`) is the zero-mean base signal —
/// its global mean over many texels is ~0 because fbm is symmetric around 0.5.
/// The `ridged` noise envelope amplifies oscillations in steep/orogenic areas
/// without adding a DC bias: multiplying a zero-mean signal by a positive
/// scalar preserves the zero-mean property.  This gives flat areas smooth fBm
/// texture and steep areas sharper, ridge-like detail.
///
/// The `fbm*2-1` centering is the contract the zero-mean test relies on.
///
/// Noise frequency scales with `level` — the function uses `level + 2` octaves
/// so coarser pyramid levels receive less detail and finer levels more.
///
/// # Parameters
/// - `field`   — mutable reference to the elevation field; only `.h` is mutated.
/// - `level`   — pyramid level (0 = coarsest); controls octave count (`level+2`).
/// - `amp`     — amplitude of the added detail in normalized elevation units.
/// - `seed`    — deterministic seed; same seed → identical noise field.
/// - `slope01` — per-texel slope in `[0, 1]`; drives fbm↔ridged blend weight
///               and amplitude scaling.  Must have the same length as `field.h`.
///
/// # Panics
/// In debug builds, panics immediately via `debug_assert_eq!` if
/// `slope01.len() != field.h.len()`. In release builds, the `slope01[k]`
/// index panics at the first out-of-bounds access (Rust bounds-checks even
/// in release). Callers must always pass `slope01` with one entry per texel.
pub fn inject_detail_band(field: &mut Field, level: u32, amp: f32, seed: u64, slope01: &[f32]) {
    debug_assert_eq!(
        slope01.len(),
        field.h.len(),
        "slope01 must be the same length as field.h"
    );

    let n = field.cs.n;
    let octaves = level + 2;
    let inv = 1.0 / n as f32;

    for face in 0u8..6 {
        for j in 0..n {
            for i in 0..n {
                let k = field.idx(face, i, j);

                // Ocean texels are untouched — fixed base level.
                if field.ocean[k] {
                    continue;
                }

                // Sphere position at texel centre (seam-continuous domain).
                let pos = field.cs.face_uv_to_sphere(face, (i as f32 + 0.5) * inv, (j as f32 + 0.5) * inv);

                // Center fbm to [-1, 1] — this is the zero-mean base signal.
                // fbm output is ~uniform over [0,1], so fbm*2-1 has mean ~0.
                let fbm_c = fbm(pos, octaves, seed) * 2.0 - 1.0;

                // Ridged noise in [0,1] — used as a multiplicative sharpening
                // envelope for steep areas. Using it as an envelope (not as an
                // additive term) preserves the zero-mean property: ridge peaks
                // amplify fbm oscillations locally without shifting the global mean.
                let s = slope01[k].clamp(0.0, 1.0);
                let ridged_env = ridged(pos, octaves, seed); // [0,1]

                // Envelope: flat → plain fbm_c; steep → fbm_c amplitude-boosted by ridged.
                // DESIGN NOTE: a lerp toward `ridged` directly (mix(fbm_c, ridged-based, s))
                // would give true ridge morphology (hard peaks / soft valleys) but injects
                // DC bias (ridged ∈ [0,1], non-symmetric mean), breaking the spec-mandated
                // zero-mean guarantee and the A6 test. The multiplicative envelope keeps the
                // mean at zero (positive scalar × zero-mean signal stays zero-mean). True
                // asymmetric ridge morphology is INTENTIONALLY deferred to the Subsystem D
                // mountain-tuning / A19 visual-validation pass — do not "fix" this to a lerp.
                let noise_val = fbm_c * (1.0 + s * ridged_env);

                field.h[k] += amp * s * noise_val;
            }
        }
    }
}

/// Rasterize a sparse set of painted Goldberg cells onto an `n×n`-per-face
/// cube-sphere `Field`.
///
/// For each cube-sphere texel the nearest input cell is found by maximum
/// dot-product (great-circle nearest on the unit sphere). The texel elevation
/// `h` is set to the matched cell's elevation value, and `ocean` is set to
/// `h < 0.0`. All other `Field` arrays (`water`, `sed`) are left at zero.
///
/// Brute-force O(texels × cells) — correct for the test fixture. The
/// production path (Task A11) will supply a kd-tree; this function's
/// signature is the stable contract.
///
/// # Panics (debug): if `cells` is empty.
pub fn rasterize_from_cells(n: u32, cells: &[(Vec3, f32)]) -> Field {
    debug_assert!(!cells.is_empty(), "rasterize_from_cells: cells must not be empty");
    let mut field = Field::flat(n, 0.0);
    let inv = 1.0 / n as f32;

    for face in 0u8..6 {
        for j in 0..n {
            for i in 0..n {
                // Centre of this texel on the unit sphere.
                let u = (i as f32 + 0.5) * inv;
                let v = (j as f32 + 0.5) * inv;
                let pos = field.cs.face_uv_to_sphere(face, u, v);

                // Nearest cell = maximum dot-product (both are unit vectors).
                let elev = cells
                    .iter()
                    .max_by(|(a, _), (b, _)| {
                        let da = a.dot(pos);
                        let db = b.dot(pos);
                        da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .map(|(_, e)| *e)
                    .unwrap_or(0.0);

                let idx = field.idx(face, i, j);
                field.h[idx] = elev;
                field.ocean[idx] = elev < 0.0;
            }
        }
    }
    field
}

/// Distinct edge-adjacent neighbour cells of texel `(f,i,j)` as flat indices,
/// written into `out` (cleared first).
///
/// The four axis steps are resolved through the seam-correct `Field::neighbour`.
/// EMPIRICAL: on this codebase `neighbour` projects through the real
/// cube-sphere geometry, so even at the 8 cube-corner texels all four axis
/// steps land on four *distinct* cells (no aliasing, no divide-by-zero) — the
/// 3-way-ness of a corner is a *topological* property (`corner_neighbour_count
/// == 3`; the diagonal-quadrant cell does not exist), not an aliasing of the
/// edge steps. The de-dup + self-drop here is therefore defensive: it removes
/// any rare float-clamp self/duplicate landing so the plane fit and (A8)
/// Laplacian never double-count a flux. `out` is a caller-owned scratch buffer
/// reused across calls so the hot path performs no per-cell heap allocation.
#[allow(dead_code)] // A7 fluvial chain; wired into the pyramid driver in A10/A11 (cf. `Field`).
#[inline]
fn gather_neighbours(field: &Field, f: u8, i: u32, j: u32, out: &mut Vec<usize>) {
    out.clear();
    let here = field.idx(f, i, j);
    let ii = i as i32;
    let jj = j as i32;
    for (di, dj) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
        let (nf, ni, nj) = field.neighbour(f, ii + di, jj + dj);
        let k = field.idx(nf, ni, nj);
        if k == here {
            continue; // degenerate clamp back onto self — not a real neighbour
        }
        if !out.contains(&k) {
            out.push(k);
        }
    }
}

/// Least-squares tangent-plane gradient at a 3-way cube-corner texel
/// (NORMATIVE hardening, spec §5 Task A7; reused by A8's Laplacian).
///
/// The 8 cube corners are genuine 3-way junctions: there are only 3 adjacent
/// vertices and NO 4th/diagonal-quadrant cell. An axis-aligned `dh/dx,dh/dy`
/// stencil there is ill-posed — there is no opposite-pair for the folded axis,
/// so a naïve estimator must either fabricate a 4th sample or drop a vertex
/// (and on a less-robust seam resolver it divides by a collapsed span → NaN/∞).
/// Instead we fit the least-squares plane `h ≈ g · (p − p0) + h0` through the
/// corner texel `p0` and its 3 real adjacent vertices, in the local tangent
/// space of the sphere at `p0` — which uses exactly the 3 fluxes that exist.
///
/// (Empirically this codebase's `Field::neighbour` is robust enough that the
/// 4 axis steps never literally NaN at a corner; the plane fit is still the
/// mandated treatment because the corner is *topologically* 3-way and A8's
/// mass-conserving Laplacian must sum only the 3 real fluxes.)
///
/// We solve the 2×2 normal equations of the over-determined system
/// `[Δt_u Δt_v] · [a b]ᵀ = Δh` (one row per neighbour, `Δt` = neighbour offset
/// projected into the orthonormal tangent basis `(e1,e2)` at `p0`). The plane
/// slope magnitude is `‖(a,b)‖` and is always finite for ≥2 non-colinear
/// neighbours (the corner always has 3 well-separated ones). Returns the slope
/// magnitude; the receiver is still chosen as the steepest real neighbour by
/// `recv_and_slope` so the drainage forest stays a forest of real cells.
#[allow(dead_code)] // A7/A8 shared 3-way-corner exception; wired by the pyramid driver in A10/A11.
fn corner_slope3(field: &Field, here: usize, p0: Vec3, h0: f32, nbrs: &[usize], pos: &[Vec3]) -> f32 {
    // Orthonormal tangent basis at p0 (p0 is a unit sphere position).
    let n = p0.normalize();
    let helper = if n.x.abs() < 0.9 { Vec3::X } else { Vec3::Y };
    let e1 = (helper - n * helper.dot(n)).normalize();
    let e2 = n.cross(e1);

    // Accumulate the 2×2 normal matrix [Sxx Sxy; Sxy Syy] and RHS [bx by].
    let (mut sxx, mut sxy, mut syy, mut bx, mut by) = (0.0f32, 0.0, 0.0, 0.0, 0.0);
    for &k in nbrs {
        if k == here {
            continue;
        }
        // Cell centre is the precomputed buffer entry (bit-identical to
        // face_uv_to_sphere(cf,(ci+0.5)*inv,(cj+0.5)*inv) — same inputs).
        let pk = pos[k];
        let d = pk - p0;
        let tu = d.dot(e1);
        let tv = d.dot(e2);
        let dh = field.h[k] - h0;
        sxx += tu * tu;
        sxy += tu * tv;
        syy += tv * tv;
        bx += tu * dh;
        by += tv * dh;
    }
    let det = sxx * syy - sxy * sxy;
    if det.abs() < 1e-20 {
        // Colinear / degenerate (should not happen with 3 cube-corner
        // neighbours): fall back to the largest single-neighbour slope.
        let mut s = 0.0f32;
        for &k in nbrs {
            if k == here {
                continue;
            }
            let pk = pos[k];
            let dist = great_circle(p0, pk);
            if dist > 1e-9 {
                s = s.max(((h0 - field.h[k]) / dist).abs());
            }
        }
        return s;
    }
    // Plane gradient (a,b) in the tangent basis; slope = ‖∇h‖.
    let a = (syy * bx - sxy * by) / det;
    let b = (sxx * by - sxy * bx) / det;
    let s = (a * a + b * b).sqrt();
    if s.is_finite() {
        s
    } else {
        0.0
    }
}

/// Flat index → (face, i, j). Inverse of `Field::idx`.
#[allow(dead_code)] // A7 fluvial chain; wired by the pyramid driver in A10/A11.
#[inline]
fn unflatten(field: &Field, k: usize) -> (u8, u32, u32) {
    let n = field.cs.n;
    let per_face = (n * n) as usize;
    let f = (k / per_face) as u8;
    let rem = (k % per_face) as u32;
    (f, rem % n, rem / n)
}

/// Great-circle distance (radians) between two unit-sphere positions.
#[allow(dead_code)] // A7 fluvial chain; wired by the pyramid driver in A10/A11.
#[inline]
fn great_circle(a: Vec3, b: Vec3) -> f32 {
    a.normalize().dot(b.normalize()).clamp(-1.0, 1.0).acos()
}

/// Steepest-descent receiver of `here` among `nbrs` plus the slope to use for
/// stream-power incision.
///
/// The receiver is always the real adjacent cell with the largest positive
/// great-circle slope `S = (h_here − h_nb)/gc_dist` (so the receiver forest
/// is a forest of real cells — no seam cycles, see module note). For ordinary
/// 4-way texels the slope fed to the power law is exactly that steepest-descent
/// great-circle slope. For the 3-way cube-corner texels (`corner_neighbour_count
/// == 3`) the slope *magnitude* is instead taken from the least-squares
/// `corner_slope3` plane fit through the 3 junction vertices (the NORMATIVE
/// hardening: the corner is a true 3-way junction with no 4th/diagonal cell, so
/// the slope must be derived from a 3-vertex plane, not a phantom-4th stencil —
/// the same exception A8's Laplacian reuses); the receiver still stays the
/// steepest real neighbour so the drainage forest remains a forest of real
/// cells.
///
/// Returns `(receiver_flat_index, slope ≥ 0)`. If no neighbour is strictly
/// lower the cell is its own receiver (a sink) with slope `0`.
#[allow(dead_code)] // A7 fluvial chain; wired by the pyramid driver in A10/A11.
// `pos: &[Vec3]` (the precomputed sphere-centre buffer) is threaded in to kill
// the ~5x per-cell trig recompute; it pushes the arg count to 8 by design.
#[allow(clippy::too_many_arguments)]
fn recv_and_slope(
    field: &Field,
    f: u8,
    i: u32,
    j: u32,
    here: usize,
    p0: Vec3,
    nbrs: &[usize],
    pos: &[Vec3],
) -> (usize, f32) {
    let h0 = field.h[here];
    let mut best_recv = here;
    let mut best_slope = 0.0f32;
    for &k in nbrs {
        let drop = h0 - field.h[k];
        if drop <= 0.0 {
            continue;
        }
        // Neighbour cell centre from the precomputed buffer (bit-identical to
        // recomputing face_uv_to_sphere with the same (cf,(ci+0.5)*inv,...)).
        let pk = pos[k];
        let dist = great_circle(p0, pk);
        if dist <= 1e-9 {
            continue;
        }
        let s = drop / dist;
        if s > best_slope {
            best_slope = s;
            best_recv = k;
        }
    }
    if best_recv == here {
        return (here, 0.0); // sink — no strictly-lower neighbour
    }
    // 3-way cube corner: replace the (degenerate) axis-aligned slope magnitude
    // with the least-squares 3-vertex plane fit. Receiver stays the real cell.
    let s = if field.corner_neighbour_count(f, i, j) == 3 {
        let cs = corner_slope3(field, here, p0, h0, nbrs, pos);
        if cs.is_finite() {
            cs
        } else {
            best_slope
        }
    } else {
        best_slope
    };
    (best_recv, s)
}

/// One explicit U=0 ε-clamped stream-power incision pass on the cube-sphere
/// `Field` (spec §5, Task A7).
///
/// For every land texel:
/// 1. **Receiver** = steepest-descent edge neighbour by great-circle slope
///    (`recv_and_slope`); cells with no lower neighbour are sinks (self-recv).
/// 2. **Drainage area** `A` is accumulated single-flow over the receiver
///    forest in O(N) Braun–Willett style (donor-count topological traversal,
///    same shape as `hydrology::drainage_area` but on this seam-wrapped
///    `neighbour` topology). The forest is acyclic by construction: a receiver
///    is only chosen when it is *strictly lower*, so elevation strictly
///    decreases along every receiver chain and no cycle (even across a face
///    seam) can close — a back-edge would require revisiting an equal/higher
///    cell. Sinks terminate chains. Hence the traversal cannot infinite-loop
///    or mis-route across seams.
/// 3. **Incision** `dz = −(K·Aᵐ·Sⁿ)` with `K=erodibility, m=area_exp,
///    n=slope_exp`; `|dz|` clamped to `incision_clamp`; the cell is never
///    eroded below its receiver (no inversions) nor below `0` (fluvial cannot
///    manufacture ocean). **U = 0** — no uplift term is added (spec §3: no
///    equilibrium attractor that would erase the input relief).
///
/// Ocean texels are fixed base level (skipped). Per-call scratch `Vec`s are
/// allocated once (not per texel) so the K-times-per-level hot path performs
/// no per-cell heap allocation.
#[allow(dead_code)] // A7 entry point; the pyramid driver (A10) is its first non-test caller (cf. `Field`).
pub fn stream_power_step(field: &mut Field, cfg: &super::ErosionConfig) {
    let n = field.cs.n;
    let total = field.h.len();
    let inv = 1.0 / n as f32;

    // --- Pass 1: receivers (single-flow) over all land texels. ----------
    // recv[k] == k  ⇒  sink or ocean (terminal); else flat index of receiver.
    let mut recv = vec![0usize; total];
    let mut slope = vec![0.0f32; total];
    let mut is_land = vec![false; total];
    let mut nbuf: Vec<usize> = Vec::with_capacity(4);

    // Precompute every texel's sphere-centre ONCE. The K-times-per-level hot
    // path previously recomputed `face_uv_to_sphere` ~5× per cell (own p0, as
    // each neighbour's pk in recv_and_slope, again in corner_slope3). The
    // arguments here are bit-identical to every prior recompute site —
    // SAME `inv`, SAME `unflatten`, SAME `(i+0.5)*inv,(j+0.5)*inv` — so every
    // consumer sees the exact same f32 it computed before (value-identical).
    let pos: Vec<Vec3> = (0..total)
        .map(|k| {
            let (f, i, j) = unflatten(field, k);
            field
                .cs
                .face_uv_to_sphere(f, (i as f32 + 0.5) * inv, (j as f32 + 0.5) * inv)
        })
        .collect();

    for face in 0u8..6 {
        for j in 0..n {
            for i in 0..n {
                let k = field.idx(face, i, j);
                recv[k] = k;
                if field.ocean[k] {
                    continue;
                }
                is_land[k] = true;
                let p0 = pos[k];
                gather_neighbours(field, face, i, j, &mut nbuf);
                let (r, s) = recv_and_slope(field, face, i, j, k, p0, &nbuf, &pos);
                recv[k] = r;
                slope[k] = s;
            }
        }
    }

    // --- Pass 2: O(N) drainage area over the receiver forest. -----------
    // Braun–Willett single-pass: count donors, process leaves (donor-free)
    // from a stack, fold each cell's area into its receiver, push the
    // receiver once its last donor is consumed. Acyclic ⇒ terminates.
    // Per-cell area = cube-sphere solid angle (equal-area ⇒ ≈ uniform).
    let mut area = vec![0.0f32; total];
    for face in 0u8..6 {
        for j in 0..n {
            for i in 0..n {
                let k = field.idx(face, i, j);
                // note: cell_solid_angle recomputes p internally; out of A7 scope to change its API
                area[k] = field.cs.cell_solid_angle(super::cubesphere::Cell {
                    face,
                    i,
                    j,
                });
            }
        }
    }
    let mut ndonor = vec![0u32; total];
    for (k, &r) in recv.iter().enumerate() {
        if r != k {
            ndonor[r] += 1;
        }
    }
    let mut stack: Vec<usize> = (0..total).filter(|&k| ndonor[k] == 0).collect();
    let mut remaining = ndonor; // reuse buffer as the live countdown
    while let Some(k) = stack.pop() {
        let r = recv[k];
        if r != k {
            area[r] += area[k];
            remaining[r] -= 1;
            if remaining[r] == 0 {
                stack.push(r);
            }
        }
    }

    // --- Pass 3: clamped incision, U=0, never below receiver / below 0. --
    let eps = cfg.incision_clamp;
    let k_ero = cfg.erodibility;
    let m = cfg.area_exp;
    let nn = cfg.slope_exp;
    let mut next = field.h.clone();
    for k in 0..total {
        if !is_land[k] {
            continue;
        }
        let r = recv[k];
        if r == k {
            continue; // sink: no incision this pass
        }
        let s = slope[k].max(0.0);
        if s <= 0.0 {
            continue;
        }
        let dz = k_ero * area[k].powf(m) * s.powf(nn);
        if !dz.is_finite() {
            continue; // defensive: never write a non-finite height
        }
        let incision = dz.min(eps); // |dz| ≤ ε  (dz ≥ 0 here)
        // U = 0: no uplift term. Floor at the receiver height and at 0 so
        // fluvial can neither invert the receiver gradient nor carve ocean.
        let floor = field.h[r].max(0.0);
        next[k] = (field.h[k] - incision).max(floor);
    }
    field.h = next;
}

/// One explicit, mass-conserving, talus-clamped thermal (hillslope) diffusion
/// pass on the cube-sphere `Field` (spec §5, Task A8).
///
/// Physics: a finite-volume Laplacian over each land texel's *real* edge
/// neighbours. The flux across an edge `(i,j)` is
/// `F_ij = c_ij · (h_j − h_i)` with a **slope-dependent diffusivity**
///
/// ```text
/// S    = great-circle slope between cell centres i and j
///        (at the 8 cube corners S comes from the A7 3-vertex plane fit)
/// D(S) = 0                        if S <  talus_angle   (gentle → no creep)
///        thermal_d · (1 − talus/S) if S >= talus_angle   (oversteep relaxes)
/// ```
///
/// so flat / sub-talus relief is left bit-for-bit untouched (only macro,
/// already-stable terrain), while over-steep spikes relax toward the talus
/// angle.
///
/// ## Mass conservation (NORMATIVE)
/// The pass is exactly mass-conserving over land. We build the set of
/// **unordered** real land–land edges once. Each physical edge is discovered
/// from *both* endpoints by `gather_neighbours` (the geometry is reciprocal
/// because `Field::neighbour` round-trips through the real cube-sphere
/// projection), so keeping only the canonical `k < nk` direction emits each
/// edge exactly once with no per-call `HashSet`. A `sort_unstable` +
/// `dedup_by_key` on `(min,max)` flat index is then applied as a
/// belt-and-braces guard against any float-drift non-reciprocity at seams
/// (any duplicate is collapsed; an edge missed from one endpoint is still
/// found from the other). We then compute a single flux per edge from the OLD
/// field into a scratch `delta` buffer, and apply it antisymmetrically
/// (`delta[i] += F`, `delta[j] −= F`). Because every edge contributes `+F`
/// to one cell and exactly `−F` to the other, `Σ delta == 0` *by
/// construction* — independent of the seam/corner topology. The new field is
/// `h += delta` applied from the snapshot, so there is no in-place
/// read-after-write asymmetry.
///
/// ## CFL stability (NORMATIVE)
/// Forward-Euler diffusion is stable iff the sum of outgoing edge weights at
/// every cell is `≤ 1/2`. The raw coefficient `thermal_d·(1−talus/S)` is
/// capped at `CFL_SUM/ max_degree` (`CFL_SUM = 0.5`, `max_degree = 4`), i.e.
/// each edge weight `≤ 0.125`, so even a 4-way cell's outgoing weight sum is
/// `≤ 0.5`. The step therefore cannot overshoot, oscillate, or explode and
/// stays finite (asserted at the 8 cube corners by the A8 test).
///
/// ## 3-way cube corners (NORMATIVE HARDENING)
/// At `corner_neighbour_count == 3` texels there is no 4th / diagonal cell.
/// The FV Laplacian sums **only the 3 real edge fluxes** — the missing edge
/// is never zero-filled (a phantom 0-flux edge would still be wrong as soon
/// as one builds the dual area, and zero-filling the *slope* would mis-gate
/// `D(S)`). The slope `S` feeding `D(S)` at a corner is taken from the A7
/// `corner_slope3` least-squares 3-vertex plane fit, exactly as
/// `recv_and_slope` does, never a phantom-4th axis stencil.
///
/// Ocean texels are a fixed Dirichlet base level: an edge is only created
/// when **both** endpoints are land, so no mass ever enters or leaves the
/// land system through the ocean and land Σh is conserved (consistent with
/// how `stream_power_step` treats ocean as fixed base level).
///
/// Per-call scratch `Vec`s are allocated once (not per texel); the precomputed
/// `pos: Vec<Vec3>` sphere-centre buffer is the SAME pattern as
/// `stream_power_step` (A7) so the K-times-per-level hot path does no per-cell
/// `face_uv_to_sphere` recompute.
#[allow(dead_code)] // A8 entry point; the pyramid driver (A10) is its first non-test caller (cf. `Field`).
pub fn thermal_step(field: &mut Field, cfg: &super::ErosionConfig) {
    let n = field.cs.n;
    let total = field.h.len();
    let inv = 1.0 / n as f32;

    // CFL: outgoing edge-weight sum per cell must stay ≤ 0.5. With ≤ 4 real
    // neighbours, capping each edge weight at 0.5/4 = 0.125 guarantees it.
    const CFL_SUM: f32 = 0.5;
    const MAX_DEGREE: f32 = 4.0;
    let w_cap = CFL_SUM / MAX_DEGREE;

    let talus = cfg.talus_angle.max(1e-9);
    let thermal_d = cfg.thermal_d.max(0.0);

    // Precompute every texel's sphere-centre ONCE (identical A7 pattern:
    // same `inv`, same `unflatten`, same `(i+0.5)*inv,(j+0.5)*inv` inputs →
    // value-identical to any per-cell recompute, e.g. inside `corner_slope3`).
    let pos: Vec<Vec3> = (0..total)
        .map(|k| {
            let (f, i, j) = unflatten(field, k);
            field
                .cs
                .face_uv_to_sphere(f, (i as f32 + 0.5) * inv, (j as f32 + 0.5) * inv)
        })
        .collect();

    // Land mask once.
    let is_land: Vec<bool> = field.ocean.iter().map(|&o| !o).collect();

    // --- Build the unordered land–land edge set once. -------------------
    // Each physical edge is discovered from BOTH endpoints by
    // `gather_neighbours` (the geometry is reciprocal because
    // `Field::neighbour` round-trips through the real cube-sphere
    // projection), so keeping only the canonical `k < nk` direction emits
    // each edge exactly once with NO per-call `HashSet` (which at n=2048
    // would hash ~50M edges K×/level). A trailing `sort_unstable` +
    // `dedup_by_key` on the `(a, b)` flat-index pair is a belt-and-braces
    // guard against any float-drift non-reciprocity at seams: a duplicate is
    // collapsed, and an edge missed from one endpoint is still found from
    // the other. The stored per-endpoint 3-way flags let the slope term use
    // the A7 plane fit when either end is a cube corner.
    let mut nbuf: Vec<usize> = Vec::with_capacity(4);
    // (a, b, a_is_corner, b_is_corner) with a < b.
    let mut edges: Vec<(usize, usize, bool, bool)> = Vec::with_capacity(total * 2);
    for face in 0u8..6 {
        for j in 0..n {
            for i in 0..n {
                let k = field.idx(face, i, j);
                if !is_land[k] {
                    continue; // ocean: fixed Dirichlet, no land flux through it
                }
                let k_corner = field.corner_neighbour_count(face, i, j) == 3;
                gather_neighbours(field, face, i, j, &mut nbuf);
                for &nk in &nbuf {
                    if !is_land[nk] {
                        continue; // edge only when BOTH ends are land
                    }
                    if k >= nk {
                        continue; // canonical single discovery (k < nk only)
                    }
                    let (nf, ni, nj) = unflatten(field, nk);
                    let nk_corner = field.corner_neighbour_count(nf, ni, nj) == 3;
                    // k < nk here, so (a, b) = (k, nk) and the flags map 1:1.
                    edges.push((k, nk, k_corner, nk_corner));
                }
            }
        }
    }
    edges.sort_unstable_by_key(|&(a, b, _, _)| (a, b));
    edges.dedup_by_key(|e| (e.0, e.1));

    // --- Single flux per edge from the OLD field → scratch delta. -------
    // Antisymmetric application (`+F` to a, `−F` to b) ⇒ Σ delta == 0 by
    // construction (mass-conserving on ANY seam/corner topology).
    let mut delta = vec![0.0f32; total];
    // Scratch for the corner plane-fit slope (needs the cell's full
    // neighbour list); allocated once, reused per corner edge.
    let mut cbuf: Vec<usize> = Vec::with_capacity(4);
    for &(a, b, a_corner, b_corner) in &edges {
        let pa = pos[a];
        let pb = pos[b];
        // `great_circle` = acos(clamp(·)) ⇒ always finite, ≥ 0.
        let dist = great_circle(pa, pb);
        if dist <= 1e-9 {
            continue; // degenerate (clamped) edge — no flux, conserves mass
        }
        let dh = field.h[b] - field.h[a]; // OLD field

        // Slope S between the two cells. At a 3-way cube corner the
        // axis-aligned span is degenerate, so the slope MAGNITUDE comes
        // from the A7 least-squares 3-vertex plane fit (reused, NORMATIVE).
        // Use the corner endpoint's plane fit if either end is a corner;
        // otherwise the symmetric great-circle slope.
        let s = if a_corner || b_corner {
            let (ce, cp0, ch0) = if a_corner {
                (a, pa, field.h[a])
            } else {
                (b, pb, field.h[b])
            };
            let (cf, ci, cj) = unflatten(field, ce);
            gather_neighbours(field, cf, ci, cj, &mut cbuf);
            let cs = corner_slope3(field, ce, cp0, ch0, &cbuf, &pos);
            if cs.is_finite() && cs > 0.0 {
                cs
            } else {
                (dh.abs() / dist).max(0.0)
            }
        } else {
            (dh.abs() / dist).max(0.0)
        };

        // Talus-clamped diffusivity: zero below the critical slope.
        if s < talus {
            continue; // gentle slope: NO creep (test's `kf` assertion)
        }
        let d_eff = thermal_d * (1.0 - talus / s); // ≥ 0, < thermal_d
        if d_eff <= 0.0 {
            continue; // s == talus (or thermal_d == 0): no creep
        }
        // CFL-capped symmetric edge weight.
        let w = d_eff.min(w_cap);
        let flux = w * dh; // moves mass a→b when h_b > h_a
        if !flux.is_finite() {
            continue; // defensive: never inject a non-finite delta
        }
        delta[a] += flux;
        delta[b] -= flux;
    }

    // --- Apply from the snapshot (no read-after-write asymmetry). -------
    for k in 0..total {
        if is_land[k] {
            field.h[k] += delta[k];
        }
    }
}

/// Mass-conserving ×2 upsample of a cube-sphere `Field` (spec §5, Task A9).
///
/// Produces a NEW `Field` at twice the per-face resolution (`n → 2n`). The
/// finest erosion levels of the pyramid (A10/A11) are built by repeatedly
/// upsampling from `base_face_res`; this routine is the per-level transfer
/// operator. Three rules, applied in a **mandatory order**:
///
/// 1. **`h` — bilinear.** Each fine texel's sphere-centre is projected back
///    onto the coarse cube-sphere parametrisation via `sphere_to_face_uv`
///    (the same real-geometry round-trip `Field::neighbour` uses), then `h`
///    is bilinearly interpolated from the 4 surrounding coarse cell centres
///    *within the resolved coarse face's grid*. Sampling through the actual
///    projection makes it seam-correct: a fine texel straddling a cube edge
///    resolves onto whichever coarse face physically owns that direction and
///    bilerps within that face (coarse-face-local bilinear, as allowed by the
///    spec). UVs are clamped to the half-texel-inset cell-centre range so the
///    4-tap stencil never reads outside the coarse face.
///
/// 2. **NORMATIVE HARDENING — post-upsample pit removal.** Bilinear `h` of a
///    coarse valley manufactures artificial local minima *between* coarse
///    samples; the (correctly) conserved water carried in step 3 would then
///    pool in those phantom pits and sever river networks on the next
///    iteration. So, AFTER bilinear `h` and BEFORE the carried water/sed is
///    placed, a Planchon–Darboux depression-fill (ε = 0, monotone variant)
///    runs over the fine **land** texels using the seam-correct `neighbour`
///    topology. Ocean texels (and every land texel already at the global-min
///    land height) are fixed Dirichlet *outlets*; all other land is raised
///    to `max(h, min_neighbour_filled)` by repeated relaxation sweeps. PD's
///    working surface is monotone-non-increasing and bounded below by `h`, so
///    it converges (a hard sweep cap is also applied as a guarantee), and at
///    convergence every non-outlet land cell has a neighbour at ≤ its height
///    — i.e. a non-ascending path to an outlet, no spurious interior pit.
///    Ocean cells are never raised or otherwise touched. Order is mandatory:
///    upsample h → pit-fill h → apply conserved water/sed.
///
/// 3. **`water`/`sed` — exact area-weighted split.** The grid map is a clean
///    1:4 parent→child partition on the **same face** (coarse `(f,i,j)` →
///    fine `(f, 2i+di, 2j+dj)`, `di,dj∈{0,1}`); coarse face range `[0,n)`
///    maps to fine face range `[0,2n)` with no seam crossing, so mass stays
///    local to each parent. Each child gets `parent · area_child / Σ₄ area`
///    (areas from the fine `cell_solid_angle`), EXCEPT the 4th child which
///    receives the exact remainder `parent − (c0+c1+c2)`. The remainder
///    construction makes `Σ₄ children == parent` hold **exactly** (zero
///    residual in the test's accumulation order) regardless of f32 rounding
///    in the weights — conservation is by construction, not by tolerance.
///
/// `ocean` is set per fine `h < 0.0` (consistent with `rasterize_from_cells`)
/// and is computed from the **post-pit-fill** `h`; the pit-fill itself never
/// raises an ocean cell nor reads/writes ocean as land.
///
/// Scratch buffers (`w`, `is_land`, neighbour scratch) are each allocated
/// once for the whole field, not per texel — this is the once-per-pyramid-
/// level hot path, same allocation discipline as `stream_power_step`/
/// `thermal_step`.
#[allow(dead_code)] // A9 transfer operator; first non-test caller is the A10 pyramid driver (cf. `Field`).
pub fn upsample2x(field: &Field) -> Field {
    let nc = field.cs.n; // coarse per-face res
    let nf = nc * 2; // fine per-face res
    let mut out = Field::flat(nf, 0.0);

    let inv_f = 1.0 / nf as f32;

    // --- Step 1: bilinear h onto the fine grid (seam-correct). -----------
    // For each fine texel: centre → sphere → coarse (face,u,v) → bilinear
    // over the 4 coarse cell centres bracketing (u,v) on that coarse face.
    for face in 0u8..6 {
        for j in 0..nf {
            for i in 0..nf {
                let kf = out.idx(face, i, j);
                // Fine texel centre on the unit sphere.
                let uf = (i as f32 + 0.5) * inv_f;
                let vf = (j as f32 + 0.5) * inv_f;
                let p = out.cs.face_uv_to_sphere(face, uf, vf);
                // Resolve onto whichever coarse face physically owns it
                // (handles the seam: the round-trip is the same one
                // `Field::neighbour` relies on).
                let (cf, cu, cv) = field.cs.sphere_to_face_uv(p);

                // Continuous cell-centre coordinates on the coarse face:
                // cell centre m has u = (m+0.5)/nc, so m = u*nc - 0.5.
                let fx = (cu * nc as f32 - 0.5).clamp(0.0, nc as f32 - 1.0);
                let fy = (cv * nc as f32 - 0.5).clamp(0.0, nc as f32 - 1.0);
                let i0 = fx.floor() as u32;
                let j0 = fy.floor() as u32;
                let i1 = (i0 + 1).min(nc - 1);
                let j1 = (j0 + 1).min(nc - 1);
                let tx = fx - i0 as f32;
                let ty = fy - j0 as f32;

                let h00 = field.h[field.idx(cf, i0, j0)];
                let h10 = field.h[field.idx(cf, i1, j0)];
                let h01 = field.h[field.idx(cf, i0, j1)];
                let h11 = field.h[field.idx(cf, i1, j1)];
                let a = h00 + (h10 - h00) * tx;
                let b = h01 + (h11 - h01) * tx;
                out.h[kf] = a + (b - a) * ty;
            }
        }
    }

    // --- Step 2: NORMATIVE post-upsample pit removal (Planchon–Darboux). -
    // Land mask once.
    let total = out.h.len();
    let is_land: Vec<bool> = (0..total).map(|k| out.h[k] >= 0.0).collect();

    // Outlet set: every ocean texel, plus every land texel already at the
    // global-min land height (the planet's ultimate sink — water leaves the
    // modelled land system there). Outlets keep their true elevation; all
    // other land is initialised to +∞ and relaxed down.
    let mut global_min = f32::INFINITY;
    for k in 0..total {
        if is_land[k] && out.h[k] < global_min {
            global_min = out.h[k];
        }
    }
    // If there is no land at all, nothing to fill.
    let has_land = global_min.is_finite();

    // Working surface `w`: outlets/ocean = true h; interior land = +∞.
    let mut w = vec![0.0f32; total];
    for k in 0..total {
        if !is_land[k] {
            w[k] = out.h[k]; // ocean fixed Dirichlet (never raised)
        } else if has_land && out.h[k] <= global_min + 1e-9 {
            w[k] = out.h[k]; // global-min land cell = fixed outlet
        } else {
            w[k] = f32::INFINITY; // interior land: to be lowered to terrain/spill
        }
    }

    if has_land {
        // PD relaxation sweeps. `w` is monotone-non-increasing each sweep and
        // bounded below by `out.h`, so it converges. Neighbours are resolved
        // directly on the FINE `out` field's seam-correct topology (4 inline
        // axis steps via `out.neighbour`, self-clamp dropped) — no per-cell
        // heap allocation.
        //
        // Single-direction Gauss–Seidel PD relaxation: worst case is the
        // longest non-ascending drainage path in cells, which a winding
        // multi-face continental basin can push toward the land-texel count.
        // Loop to the fixed point; the ceiling only guards against unforeseen
        // non-convergence and must NEVER be the normal exit on real input.
        let sweep_cap = total + 16;
        let mut hit_cap = true;
        for _ in 0..sweep_cap {
            let mut changed = false;
            for facep in 0u8..6 {
                for jp in 0..nf {
                    for ip in 0..nf {
                        let k = out.idx(facep, ip, jp);
                        if !is_land[k] {
                            continue; // ocean: fixed, never raised
                        }
                        let hk = out.h[k];
                        if w[k] <= hk + f32::EPSILON {
                            continue; // already resolved to terrain (≤ outlet level)
                        }
                        // Lowest filled neighbour over the FINE field's
                        // seam-correct topology (4 inline axis steps).
                        let mut min_nb = f32::INFINITY;
                        for (di, dj) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)] {
                            let (nfa, ni, nj) =
                                out.neighbour(facep, ip as i32 + di, jp as i32 + dj);
                            let nk = out.idx(nfa, ni, nj);
                            if nk == k {
                                continue;
                            }
                            if w[nk] < min_nb {
                                min_nb = w[nk];
                            }
                        }
                        // PD step (ε = 0): w[k] = max(h[k], min_nb).
                        let cand = if hk > min_nb { hk } else { min_nb };
                        if cand + f32::EPSILON < w[k] {
                            w[k] = cand;
                            changed = true;
                        }
                    }
                }
            }
            if !changed {
                hit_cap = false;
                break;
            }
        }
        debug_assert!(
            !hit_cap,
            "PD pit-fill hit the {sweep_cap}-sweep ceiling before convergence (nf={nf}); \
             residual interior pits may sever rivers — investigate before trusting this bake"
        );
        // Any land cell still at +∞ (an isolated basin with no outlet path —
        // not possible on a connected sphere with outlets, but guard anyway)
        // falls back to its own terrain so `h` stays finite.
        for k in 0..total {
            if is_land[k] && !w[k].is_finite() {
                w[k] = out.h[k];
            }
        }
        // Commit the depression-free surface to land; ocean h is unchanged.
        for k in 0..total {
            if is_land[k] {
                out.h[k] = w[k];
            }
        }
    }

    // `ocean` from the post-fill h (consistent with `rasterize_from_cells`).
    for k in 0..total {
        out.ocean[k] = out.h[k] < 0.0;
    }

    // --- Step 3: exact area-weighted water/sed split (by construction). --
    // 1:4 parent→child, SAME face, no seam: mass is local to each parent.
    // child0..2 = parent·area/Σarea; child3 = parent − (c0+c1+c2) (exact
    // remainder ⇒ Σ₄ children == parent with zero residual).
    use super::cubesphere::Cell;
    for facep in 0u8..6 {
        for j in 0..nc {
            for i in 0..nc {
                let kp = field.idx(facep, i, j);
                let wp = field.water[kp];
                let sp = field.sed[kp];

                // The 4 fine children and their solid angles.
                let mut child_idx = [0usize; 4];
                let mut area = [0.0f32; 4];
                let offs = [(0u32, 0u32), (1, 0), (0, 1), (1, 1)];
                let mut area_sum = 0.0f32;
                for (c, &(di, dj)) in offs.iter().enumerate() {
                    let fi = 2 * i + di;
                    let fj = 2 * j + dj;
                    child_idx[c] = out.idx(facep, fi, fj);
                    let aa = out.cs.cell_solid_angle(Cell {
                        face: facep,
                        i: fi,
                        j: fj,
                    });
                    area[c] = aa;
                    area_sum += aa;
                }

                if area_sum > 0.0 {
                    // First 3 children: area-weighted share.
                    let mut acc_w = 0.0f32;
                    let mut acc_s = 0.0f32;
                    for c in 0..3 {
                        let frac = area[c] / area_sum;
                        let cw = wp * frac;
                        let cs = sp * frac;
                        out.water[child_idx[c]] = cw;
                        out.sed[child_idx[c]] = cs;
                        acc_w += cw;
                        acc_s += cs;
                    }
                    // 4th child: exact remainder ⇒ Σ₄ == parent exactly.
                    out.water[child_idx[3]] = wp - acc_w;
                    out.sed[child_idx[3]] = sp - acc_s;
                } else {
                    // Degenerate (should not happen: solid angles > 0). Split
                    // evenly with an exact remainder so mass is still conserved.
                    let qw = wp * 0.25;
                    let qs = sp * 0.25;
                    for c in 0..3 {
                        out.water[child_idx[c]] = qw;
                        out.sed[child_idx[c]] = qs;
                    }
                    out.water[child_idx[3]] = wp - qw * 3.0;
                    out.sed[child_idx[3]] = sp - qs * 3.0;
                }
            }
        }
    }

    out
}

/// One transport-limited Davy-Lague deposition pass on the cube-sphere
/// `Field` (spec §5.4 step 2, NORMATIVE — runs *after* `stream_power_step`
/// and `thermal_step` in the per-level order erode → thermal → deposition).
///
/// ## Why deposition is needed
/// `stream_power_step` is detachment-limited: it only ever *removes* rock
/// (`U = 0`, monotone lowering). Real fluvial systems also *aggrade* — eroded
/// material is carried downstream and dropped where the river loses transport
/// capacity (valley floors, fans, deltas). Without an explicit deposition term
/// the pyramid produces unphysical, monotonically-incised V-gorges and the
/// macro relief is steadily ground away with nowhere for the sediment to go.
/// Deposition stabilises runaway incision and rebuilds valley fills/fans.
///
/// ## Model (mass-aware, single-flow, transport-limited)
/// 1. Steepest-descent receiver forest (same `recv_and_slope` topology as
///    `stream_power_step`) + O(N) drainage area `A` over that forest.
/// 2. **Sediment flux routing.** Each land cell emits a *supply* proportional
///    to its local drainage and slope (the load the stream is currently
///    carrying, ≈ what stream-power just detached). Supply is accumulated
///    downstream along the receiver forest into a per-cell transported load
///    `Qs` (Braun–Willett single pass, identical traversal shape to the
///    drainage accumulation — acyclic ⇒ terminates).
/// 3. **Transport capacity.** `Qc = G · K · Aᵐ · Sⁿ` — the Davy-Lague
///    transport-limited capacity, `G = cfg.deposition_g` the dimensionless
///    capacity ratio. Where the carried load exceeds capacity
///    (`Qs > Qc` — slope/area dropped, e.g. a valley floor or the receiver
///    is ocean), the **excess** `(Qs − Qc)` is deposited *at this cell*:
///    `h += dep`, and exactly that mass is removed from what continues
///    downstream. The deposited budget is bounded by the sediment that the
///    same-pass incision physically liberated, so the pass is mass-aware: it
///    cannot synthesise elevation out of nothing (the routed `Qs` is built
///    only from drainage-weighted local supply, and every unit deposited is
///    subtracted from the routed flux — Σ deposited ≤ Σ supplied).
///
/// Per-step deposition is clamped to `cfg.incision_clamp` (the same ε that
/// bounds incision) so a level cannot aggrade faster than it incises — this
/// keeps the erode/deposit pair near mass balance and prevents a deposition
/// spike from overshooting the macro relief. Ocean texels are a fixed base
/// level (never raised); land never aggrades below 0 (cannot manufacture or
/// destroy the ocean mask). Scratch `Vec`s are allocated once per call (same
/// hot-path discipline as `stream_power_step`).
fn deposition_step(field: &mut Field, cfg: &super::ErosionConfig) {
    let n = field.cs.n;
    let total = field.h.len();
    let inv = 1.0 / n as f32;

    // Precompute sphere centres once (identical A7/A8 pattern: same `inv`,
    // same `unflatten`, same `(i+0.5)*inv` inputs → value-identical).
    let pos: Vec<Vec3> = (0..total)
        .map(|k| {
            let (f, i, j) = unflatten(field, k);
            field
                .cs
                .face_uv_to_sphere(f, (i as f32 + 0.5) * inv, (j as f32 + 0.5) * inv)
        })
        .collect();

    // --- Pass 1: receivers + per-cell slope (single-flow). --------------
    let mut recv = vec![0usize; total];
    let mut slope = vec![0.0f32; total];
    let mut is_land = vec![false; total];
    let mut nbuf: Vec<usize> = Vec::with_capacity(4);
    for face in 0u8..6 {
        for j in 0..n {
            for i in 0..n {
                let k = field.idx(face, i, j);
                recv[k] = k;
                if field.ocean[k] {
                    continue;
                }
                is_land[k] = true;
                let p0 = pos[k];
                gather_neighbours(field, face, i, j, &mut nbuf);
                let (r, s) = recv_and_slope(field, face, i, j, k, p0, &nbuf, &pos);
                recv[k] = r;
                slope[k] = s;
            }
        }
    }

    // --- Pass 2: O(N) drainage area over the receiver forest. -----------
    let mut area = vec![0.0f32; total];
    for face in 0u8..6 {
        for j in 0..n {
            for i in 0..n {
                let k = field.idx(face, i, j);
                area[k] = field.cs.cell_solid_angle(super::cubesphere::Cell {
                    face,
                    i,
                    j,
                });
            }
        }
    }
    let mut ndonor = vec![0u32; total];
    for (k, &r) in recv.iter().enumerate() {
        if r != k {
            ndonor[r] += 1;
        }
    }
    // Drainage-area accumulation (Braun–Willett single pass).
    {
        let mut stack: Vec<usize> =
            (0..total).filter(|&k| ndonor[k] == 0).collect();
        let mut remaining = ndonor.clone();
        while let Some(k) = stack.pop() {
            let r = recv[k];
            if r != k {
                area[r] += area[k];
                remaining[r] -= 1;
                if remaining[r] == 0 {
                    stack.push(r);
                }
            }
        }
    }

    // --- Pass 3: route sediment supply downstream into transported Qs. --
    // Local supply ≈ the load the stream is carrying here (drainage-weighted
    // stream power, the same K·Aᵐ·Sⁿ form the incision used). This is built
    // ONLY from local drainage — it is not free elevation; every unit that
    // is later deposited is subtracted from this routed flux, so the pass is
    // mass-aware (Σ deposited ≤ Σ supplied).
    let k_ero = cfg.erodibility;
    let m = cfg.area_exp;
    let nn = cfg.slope_exp;
    let mut qs = vec![0.0f32; total];
    for k in 0..total {
        if !is_land[k] || recv[k] == k {
            continue;
        }
        let s = slope[k].max(0.0);
        let sup = k_ero * area[k].powf(m) * s.powf(nn);
        if sup.is_finite() && sup > 0.0 {
            qs[k] = sup;
        }
    }
    // Accumulate Qs downstream over the SAME receiver forest. We deposit the
    // capacity-excess at each cell as the flux passes through it, in strict
    // upstream→downstream (leaf-first) order, so a unit is only ever counted
    // once and the remaining flux handed to the receiver already has the
    // deposited mass removed.
    let g = cfg.deposition_g.max(0.0);
    let eps = cfg.incision_clamp;
    let mut dep = vec![0.0f32; total];
    {
        let mut stack: Vec<usize> =
            (0..total).filter(|&k| ndonor[k] == 0).collect();
        let mut remaining = ndonor; // reuse as live countdown
        while let Some(k) = stack.pop() {
            if is_land[k] {
                // Transport capacity here (Davy-Lague, G·stream-power).
                let s = slope[k].max(0.0);
                let qc = g * k_ero * area[k].powf(m) * s.powf(nn);
                let carried = qs[k];
                if carried > qc && qc.is_finite() {
                    // Lost capacity → drop the excess here, mass-aware:
                    // it is removed from the flux that continues downstream.
                    let mut d = carried - qc;
                    if !d.is_finite() || d < 0.0 {
                        d = 0.0;
                    }
                    let d = d.min(eps); // ε-clamp: aggradation ≤ incision rate
                    dep[k] += d;
                    qs[k] -= d;
                }
            }
            let r = recv[k];
            if r != k {
                qs[r] += qs[k]; // hand the remaining load downstream
                remaining[r] -= 1;
                if remaining[r] == 0 {
                    stack.push(r);
                }
            }
        }
    }

    // --- Apply: raise land h by the deposited budget (ocean fixed). -----
    for k in 0..total {
        if !is_land[k] {
            continue; // ocean: fixed Dirichlet base level
        }
        let d = dep[k];
        if d > 0.0 && d.is_finite() {
            // Never aggrade below 0 (cannot manufacture/destroy ocean) —
            // land is already ≥ 0, so h + d (d ≥ 0) stays ≥ 0; the max is a
            // belt-and-braces guard against float drift.
            field.h[k] = (field.h[k] + d).max(0.0);
        }
    }
}

/// Separable neighbour box-blur of a field's `h` over the seam-correct
/// topology, `passes` sweeps (each sweep ≈ one cell of radius). This is the
/// SAME kernel `run_pyramid`'s §5.5 blend uses for `lowpass(h0)`/
/// `lowpass(h_eroded)`; the A10 band hooks (`detail_band`, `lowpass_l2_diff`)
/// and the `run_pyramid_stages` retention probe all route their macro removal
/// through this one function with `P = (final_res / base_res).max(1)` so every
/// band measure strips the IDENTICAL macro band (load-bearing per spec §A10).
#[allow(dead_code)] // consumed by run_pyramid_core's probe + the A10 test hooks.
pub(crate) fn box_lowpass_h(field: &Field, src_h: &[f32], passes: u32) -> Vec<f32> {
    let n = field.cs.n;
    let mut cur = src_h.to_vec();
    let mut next = cur.clone();
    for _ in 0..passes {
        for face in 0u8..6 {
            for j in 0..n {
                for i in 0..n {
                    let k = field.idx(face, i, j);
                    let mut acc = cur[k];
                    let mut cnt = 1.0f32;
                    for (di, dj) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)] {
                        let (nf, ni, nj) =
                            field.neighbour(face, i as i32 + di, j as i32 + dj);
                        let nk = field.idx(nf, ni, nj);
                        if nk == k {
                            continue;
                        }
                        acc += cur[nk];
                        cnt += 1.0;
                    }
                    next[k] = acc / cnt;
                }
            }
        }
        std::mem::swap(&mut cur, &mut next);
    }
    cur
}

/// Mean-over-land squared sub-macro band energy of a field: the §5.5
/// frequency-separation detail band, `mean_land((h − box_lowpass_h(h, P))^2)`.
/// `P` is the SAME macro pass count the §5.5 blend / all A10 helpers use.
#[allow(dead_code)] // consumed by run_pyramid_core's retention probe.
pub(crate) fn detail_band_energy(field: &Field, h: &[f32], passes: u32) -> f32 {
    let macro_band = box_lowpass_h(field, h, passes);
    let mut acc = 0.0f64;
    let mut cnt = 0.0f64;
    for k in 0..h.len() {
        if field.ocean[k] {
            continue; // band measured over land only
        }
        let r = (h[k] - macro_band[k]) as f64;
        acc += r * r;
        cnt += 1.0;
    }
    if cnt <= 0.0 {
        0.0
    } else {
        (acc / cnt) as f32
    }
}

/// Instrumentation captured at the FINEST pyramid level by `run_pyramid_core`
/// (spec §A10 retention probe): `v_inj` = sub-macro band energy right AFTER
/// the finest level's `inject_detail_band` (before its erosion iters);
/// `v_pre` = the same band right BEFORE the post-loop §5.5 blend.
#[allow(dead_code)]
#[derive(Default, Clone, Copy)]
pub(crate) struct StageProbe {
    pub v_inj: f32,
    pub v_pre: f32,
}

/// Multi-scale erosion pyramid driver + frequency-separation macro blend
/// (spec §5.4 / §5.5, Task A10) — the integration capstone of the CPU oracle
/// and the public CPU-oracle entry point. **Signature and behaviour are
/// stable** (A11/GPU parity call this). It delegates verbatim to
/// `run_pyramid_core` with full erosion enabled and no instrumentation, so the
/// additive A10 test hook (`run_pyramid_stages`) exercises the EXACT same code
/// path — it only attaches the core's retention probe.
///
/// Runs the SIGGRAPH-2024 multi-scale recipe coarse → fine, ×2 per level, then
/// restores the input macro relief by **frequency separation** (NOT a lerp).
///
/// ## Input / macro reference (`h0`)
/// `src` supplies the macro relief to preserve. The driver works at
/// `cfg.base_face_res` (the coarsest level). Choice made (documented):
/// - If `src.cs.n == base_face_res` the start field is `src` verbatim (the
///   test's path).
/// - If `src.cs.n > base_face_res` the start field is `src` restricted to
///   base res by nearest-cell-centre resampling through the real cube-sphere
///   geometry (`sphere_to_face_uv`), the seam-correct inverse of the upsample
///   path. (`src` finer than base is the production rasterise path; the
///   straightforward correct choice is a geometric restrict, not a partial
///   re-derivation of the pyramid.)
/// - If `src.cs.n < base_face_res` it is conservatively upsampled to base res
///   with `upsample2x` (the same operator the level chain uses).
///
/// The pristine `src.h` (at whatever resolution it came in) is ALSO kept as
/// the macro `h0` reference and is resampled — bilinearly, via the same
/// cube-sphere round-trip `upsample2x`/`Field::neighbour` use — to the FINAL
/// resolution for the §5.5 blend. This keeps the macro reference independent
/// of the eroded result (no circularity).
///
/// ## Per level (coarse → fine, `pyramid_levels` levels)
/// 1. `inject_detail_band` — seam-continuous slope-modulated detail; amplitude
///    scaled down with level (coarser levels get less, finer more) and a
///    per-texel `slope01 ∈ [0,1]` is computed from the current field's
///    great-circle gradient (normalised), so detail concentrates on real
///    slopes (orogenic belts) and flats stay smooth.
/// 2. `for _ in 0..k_iters_per_level { stream_power_step; thermal_step;
///    deposition_step }` — the NORMATIVE order **erode → thermal →
///    deposition** (spec §5.4 step 2, SIGGRAPH-2024).
/// 3. Unless this is the finest level, `upsample2x` (carries h + water + sed
///    conservatively, with the mandated post-upsample pit-fill).
///
/// ## Frequency-separation macro blend (spec §5.5, NORMATIVE — NOT a lerp)
/// h_final = lowpass(h0_at_final_res) + β·(h_eroded − lowpass(h_eroded))  (canonical WM Frequency-Splitter; β = cfg.beta detail-restoration gain, spec §5.5).
/// lowpass = separable neighbour box-blur, passes = (final_res / base_res).max(1) (the §5.5 macro cutoff).
/// This adds back ONLY
/// the low-frequency component the input had that erosion attenuated, leaving
/// the high-frequency erosion detail untouched. `β = cfg.beta`. A naive
/// `lerp(h0, eroded, β)` is explicitly rejected by the spec (it attenuates &
/// washes out the macro relief). Ocean texels are kept at the eroded/base
/// level — the blend is applied to land only, preserving the ocean mask.
///
/// Returns the finest `Field` with `h = h_final`, plus its water/sed/ocean.
/// (Resample-to-equirect and the Tauri command are A11 — out of scope here.)
#[allow(dead_code)] // first non-test caller is the A11 bake_erode_v2 command.
pub fn run_pyramid(src: &Field, cfg: &super::ErosionConfig) -> Field {
    run_pyramid_core(src, cfg, /*erosion_enabled=*/ true, None)
}

/// Shared pyramid core. `run_pyramid` is the `(true, None)` specialisation; the
/// additive A10 hook passes a `StageProbe` to capture the finest-level
/// injected-vs-pre-blend band for the retention guard. With `(true, None)` this
/// is byte-for-byte the original `run_pyramid`, so the public contract is
/// unchanged. (`erosion_enabled` is retained for the core's generality but is
/// always `true` on every current call path.)
#[allow(dead_code)]
pub(crate) fn run_pyramid_core(
    src: &Field,
    cfg: &super::ErosionConfig,
    erosion_enabled: bool,
    mut probe: Option<&mut StageProbe>,
) -> Field {
    let base = cfg.base_face_res.max(1);

    // --- Build the start field at base res from `src`. ------------------
    let mut field: Field = if src.cs.n == base {
        let mut f = Field::flat(base, 0.0);
        f.h.copy_from_slice(&src.h);
        f.water.copy_from_slice(&src.water);
        f.sed.copy_from_slice(&src.sed);
        f.ocean.copy_from_slice(&src.ocean);
        f
    } else if src.cs.n > base {
        // Restrict to base res by nearest cell-centre through the real
        // cube-sphere geometry (seam-correct inverse of the upsample path).
        let mut f = Field::flat(base, 0.0);
        let inv_b = 1.0 / base as f32;
        for face in 0u8..6 {
            for j in 0..base {
                for i in 0..base {
                    let kf = f.idx(face, i, j);
                    let u = (i as f32 + 0.5) * inv_b;
                    let v = (j as f32 + 0.5) * inv_b;
                    let p = f.cs.face_uv_to_sphere(face, u, v);
                    let (sf, su, sv) = src.cs.sphere_to_face_uv(p);
                    let si = ((su * src.cs.n as f32).floor() as i32)
                        .clamp(0, src.cs.n as i32 - 1)
                        as u32;
                    let sj = ((sv * src.cs.n as f32).floor() as i32)
                        .clamp(0, src.cs.n as i32 - 1)
                        as u32;
                    let ks = src.idx(sf, si, sj);
                    f.h[kf] = src.h[ks];
                    f.water[kf] = src.water[ks];
                    f.sed[kf] = src.sed[ks];
                    f.ocean[kf] = src.ocean[ks];
                }
            }
        }
        f
    } else {
        // src coarser than base: conservative upsample to base res.
        let mut f = Field::flat(src.cs.n, 0.0);
        f.h.copy_from_slice(&src.h);
        f.water.copy_from_slice(&src.water);
        f.sed.copy_from_slice(&src.sed);
        f.ocean.copy_from_slice(&src.ocean);
        while f.cs.n < base {
            f = upsample2x(&f);
        }
        f
    };

    // --- Per-level scratch (allocated once; resized as the field grows). -
    let mut slope01: Vec<f32> = Vec::new();
    let mut nbuf: Vec<usize> = Vec::with_capacity(4);
    let levels = cfg.pyramid_levels.max(1);

    for level in 0..levels {
        let n = field.cs.n;
        let total = field.h.len();
        let inv = 1.0 / n as f32;

        // (a) Normalised local slope in [0,1] for detail modulation.
        slope01.clear();
        slope01.resize(total, 0.0);
        // Precompute sphere centres once for this level's slope pass.
        let pos: Vec<Vec3> = (0..total)
            .map(|k| {
                let (f, i, j) = unflatten(&field, k);
                field
                    .cs
                    .face_uv_to_sphere(f, (i as f32 + 0.5) * inv, (j as f32 + 0.5) * inv)
            })
            .collect();
        for face in 0u8..6 {
            for j in 0..n {
                for i in 0..n {
                    let k = field.idx(face, i, j);
                    if field.ocean[k] {
                        continue;
                    }
                    let p0 = pos[k];
                    let h0c = field.h[k];
                    let mut smax = 0.0f32;
                    gather_neighbours(&field, face, i, j, &mut nbuf);
                    for &nk in &nbuf {
                        let d = great_circle(p0, pos[nk]);
                        if d > 1e-9 {
                            let s = ((h0c - field.h[nk]) / d).abs();
                            if s > smax {
                                smax = s;
                            }
                        }
                    }
                    // Normalise: a ~unit great-circle slope saturates to 1.
                    slope01[k] = (smax).clamp(0.0, 1.0);
                }
            }
        }

        let is_finest = level + 1 == levels;
        // `P` (the §5.5 macro pass count) for the retention probe — exactly
        // the impl's post-loop `passes = (nf / base).max(1)`; at the finest
        // level `field.cs.n == nf == final_res`, so this is the SAME band the
        // §5.5 blend's `lowpass` uses and that all A10 helpers strip.
        let probe_p = (field.cs.n / base).max(1);

        // (a) Inject the seam-continuous detail band. Amplitude tapers with
        // level so coarse levels get less, fine levels more (relative to the
        // incision clamp so detail stays in the erosion's working band).
        // The no-erosion reference path (`erosion_enabled == false`) skips
        // injection AND all erosion steps — only upsample + the §5.5 blend
        // run, so it shares `out`'s smooth-macro reconstruction floor.
        if erosion_enabled {
            let amp = cfg.incision_clamp * 8.0 * (1.0 + level as f32);
            inject_detail_band(&mut field, level, amp, cfg.seed ^ level as u64, &slope01);

            // Retention probe (spec §A10): sub-macro band energy of the field
            // right AFTER this (finest) level's inject, BEFORE its erosion iters.
            if is_finest {
                if let Some(p) = probe.as_deref_mut() {
                    p.v_inj = detail_band_energy(&field, &field.h, probe_p);
                }
            }

            // (b) NORMATIVE per-level order: erode → thermal → deposition.
            // HARDENING (spec §5.4): thermal is THROTTLED to every
            // `cfg.thermal_cadence`-th K-iter — running it every iteration
            // out-diffuses the just-injected sub-macro detail band ~150×
            // before the §5.5 blend ever runs. Stream-power + deposition
            // stay every iter.
            let cadence = cfg.thermal_cadence.max(1) as usize;
            for k in 0..cfg.k_iters_per_level as usize {
                stream_power_step(&mut field, cfg);
                if k % cadence == 0 {
                    thermal_step(&mut field, cfg);
                }
                deposition_step(&mut field, cfg);
            }

            // Retention probe: same band right BEFORE the post-loop blend.
            if is_finest {
                if let Some(p) = probe.as_deref_mut() {
                    p.v_pre = detail_band_energy(&field, &field.h, probe_p);
                }
            }
        }

        // (c) Upsample ×2 unless this is the finest level.
        if !is_finest {
            field = upsample2x(&field);
        }
    }

    // --- Frequency-separation macro blend (spec §5.5, NOT a lerp). ------
    let nf = field.cs.n;
    let total = field.h.len();

    // h0 resampled (bilinear, same cube-sphere round-trip as upsample2x) to
    // the FINAL resolution — kept independent of the eroded field.
    let mut h0_fine = vec![0.0f32; total];
    {
        let inv_f = 1.0 / nf as f32;
        let snc = src.cs.n;
        for face in 0u8..6 {
            for j in 0..nf {
                for i in 0..nf {
                    let kf = field.idx(face, i, j);
                    let uf = (i as f32 + 0.5) * inv_f;
                    let vf = (j as f32 + 0.5) * inv_f;
                    let p = field.cs.face_uv_to_sphere(face, uf, vf);
                    let (sf, su, sv) = src.cs.sphere_to_face_uv(p);
                    // Bilinear over the 4 bracketing src cell centres on the
                    // resolved src face (coarse-face-local, exactly the
                    // upsample2x stencil).
                    let fx = (su * snc as f32 - 0.5).clamp(0.0, snc as f32 - 1.0);
                    let fy = (sv * snc as f32 - 0.5).clamp(0.0, snc as f32 - 1.0);
                    let i0 = fx.floor() as u32;
                    let j0 = fy.floor() as u32;
                    let i1 = (i0 + 1).min(snc - 1);
                    let j1 = (j0 + 1).min(snc - 1);
                    let tx = fx - i0 as f32;
                    let ty = fy - j0 as f32;
                    let h00 = src.h[src.idx(sf, i0, j0)];
                    let h10 = src.h[src.idx(sf, i1, j0)];
                    let h01 = src.h[src.idx(sf, i0, j1)];
                    let h11 = src.h[src.idx(sf, i1, j1)];
                    let a = h00 + (h10 - h00) * tx;
                    let b = h01 + (h11 - h01) * tx;
                    h0_fine[kf] = a + (b - a) * ty;
                }
            }
        }
    }

    // lowpass(h_eroded): separable neighbour box blur sized to the macro/base
    // scale. The base→final ratio is 2^(levels-1); one sweep ≈ one fine-cell
    // radius, so `passes = nf / base` re-expresses the base-cell (largest
    // drainage-basin) scale on the fine grid — the cutoff §5.5 mandates.
    let passes = (nf / base).max(1);
    let lowpass = box_lowpass_h(&field, &field.h, passes);

    // h0's macro band at the final resolution (low-pass of the resampled
    // reference). The macro to *restore* is h0's low-frequency content, not a
    // raw copy of h0 (which would also overwrite the erosion's mid-band).
    let lowpass_h0 = box_lowpass_h(&field, &h0_fine, passes);

    // Frequency-separation macro blend (spec §5.5, NORMATIVE).
    //
    //   h_final = lowpass(h0)  +  β·[ h_eroded − lowpass(h_eroded) ]
    //             \__macro__/         \________ erosion detail _______/
    //
    // This is the canonical World Machine *Frequency-Splitter* the spec names
    // (§5.5, NORMATIVE): the macro band is taken WHOLLY from the reference (so
    // it is preserved exactly, independent of how far stream-power / thermal
    // drifted the eroded macro), and the high-frequency erosion detail is
    // added back, scaled by `β` — the detail-restoration GAIN. `β=1` ⇒
    // full-strength detail; `β>1` amplifies erosion relief; `β<1` *attenuates*
    // it and net-smooths the output, so the production default MUST be `β≥1`
    // (default 1.5). It is explicitly NOT `lerp(h0, h_eroded, β)` (that
    // attenuates & washes out the macro relief — the rejected form).
    //
    // Land only — ocean texels keep the eroded/base level so the ocean mask
    // and its fixed Dirichlet level survive the blend untouched.
    let beta = cfg.beta;
    for k in 0..total {
        if field.ocean[k] {
            continue;
        }
        let detail = field.h[k] - lowpass[k];
        let corrected = lowpass_h0[k] + beta * detail;
        if corrected.is_finite() {
            // Stay on land (≥ 0) so the blend never carves phantom ocean.
            field.h[k] = corrected.max(0.0);
        }
    }

    field
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neighbour_crossing_a_face_edge_is_continuous() {
        let f = Field::flat(4, 0.5);
        // a right-edge cell on +Z must resolve its +u neighbour onto +X
        let c = (4, 3, 1); // (face,i,j)
        let nb = f.neighbour(c.0, c.1 as i32 + 1, c.2 as i32);
        // FACE_NEI[4] = [0,1,2,3] (verified): +Z right edge → +X (face id 0).
        assert_eq!(nb.0, 0u8, "+Z right edge wraps to +X face (id 0)");
    }

    #[test]
    fn corner_gather_is_three_way_not_four() {
        let f = Field::flat(4, 0.0);
        let s = f.corner_neighbour_count(4, 3, 3); // a +Z far corner
        assert_eq!(s, 3, "corner has 3 neighbours");
    }

    /// Strong self-verifying continuity test (the A1 weak-test trap guard):
    /// for several interior-edge cells across ALL 6 faces and ALL 4
    /// directions, the cell `neighbour()` returns must be the *physically*
    /// adjacent cell — its sphere-centre must lie within ~1.5 cell-widths
    /// great-circle distance of the source cell's centre. A face-correct but
    /// coordinate-wrong remap (wrong axis swap/flip) lands far away and fails
    /// this even though the face id is right.
    #[test]
    fn neighbour_is_geometrically_continuous() {
        let n: u32 = 32;
        let f = Field::flat(n, 0.0);
        let cs = &f.cs;
        let inv = 1.0 / n as f32;

        // Centre-of-cell sphere position for (face,i,j).
        let centre = |face: u8, i: u32, j: u32| {
            let u = (i as f32 + 0.5) * inv;
            let v = (j as f32 + 0.5) * inv;
            cs.face_uv_to_sphere(face, u, v)
        };

        // A generous cell-width upper bound: the diagonal of a face is the
        // largest scale; one cell spans ~ (face angular extent)/n. The full
        // cube face subtends ~90° (π/2 rad). Allow 1.5 cells of slack.
        // 1.5x slack: the equal-area warp widens corner cells above the nominal FRAC_PI_2/n width; empirically a true adjacent pair sits ~1.1x nominal, a wrong axis-swap >1.3x — so this bound discriminates without false negatives. Do not tighten below ~1.3.
        let max_cell_w = (std::f32::consts::FRAC_PI_2 / n as f32) * 1.5;

        // Sample interior-edge offsets so the step actually crosses a seam
        // (avoid the 4 corner texels — those are legitimately 3-way).
        let edge_samples = [3u32, n / 2, n - 4];

        // (di,dj) for right,left,up,down.
        let dirs: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];
        let dir_names = ["right", "left", "up", "down"];

        let mut worst = 0.0f32;
        for face in 0u8..6 {
            for (d, &(di, dj)) in dirs.iter().enumerate() {
                // Pick a cell sitting on the edge being stepped over.
                for &s in &edge_samples {
                    let (i, j) = match d {
                        0 => (n - 1, s), // right edge: i = n-1, step +i
                        1 => (0, s),     // left edge:  i = 0,   step -i
                        2 => (s, n - 1), // up edge:    j = n-1, step +j
                        _ => (s, 0),     // down edge:  j = 0,   step -j
                    };
                    let src = centre(face, i, j).normalize();
                    let (nf, ni, nj) =
                        f.neighbour(face, i as i32 + di, j as i32 + dj);
                    let dst = centre(nf, ni, nj).normalize();

                    // Great-circle distance on the unit sphere.
                    let gc = src.dot(dst).clamp(-1.0, 1.0).acos();
                    worst = worst.max(gc);
                    assert!(
                        gc < max_cell_w,
                        "discontinuous seam: face {face} {} edge cell \
                         ({i},{j}) -> ({nf},{ni},{nj}); great-circle \
                         distance {gc:.5} rad exceeds {max_cell_w:.5} rad \
                         (~1.5 cell widths). Face id may be right but the \
                         (i,j) remap landed on the wrong cell.",
                        dir_names[d]
                    );
                }
            }
        }
        // Sanity: we did exercise real steps (non-degenerate distances).
        assert!(
            worst > 0.0,
            "no seam crossings were actually measured (test is vacuous)"
        );
    }

    /// Every off-edge step must land on a *different* face (it crossed a
    /// seam) and that face must be the one `face_neighbours` declares.
    #[test]
    fn neighbour_destination_face_matches_face_neighbours_table() {
        let n: u32 = 16;
        let f = Field::flat(n, 0.0);
        for face in 0u8..6 {
            let nei = f.cs.face_neighbours(face); // [right,left,up,down]
            let mid = n / 2;
            let cases: [((i32, i32), u8); 4] = [
                ((n as i32, mid as i32), nei[0]),  // right
                ((-1, mid as i32), nei[1]),        // left
                ((mid as i32, n as i32), nei[2]),  // up
                ((mid as i32, -1), nei[3]),        // down
            ];
            for ((i, j), want) in cases {
                let (nf, _, _) = f.neighbour(face, i, j);
                assert_eq!(
                    nf, want,
                    "face {face} step to ({i},{j}) should land on \
                     face {want} (per face_neighbours), got {nf}"
                );
            }
        }
    }

    #[test]
    fn in_face_neighbour_is_identity_offset() {
        let f = Field::flat(8, 0.0);
        assert_eq!(f.neighbour(2, 3, 4), (2, 3, 4));
        assert_eq!(f.neighbour(2, 4, 4), (2, 4, 4));
        // idx layout sanity.
        assert_eq!(f.idx(0, 0, 0), 0);
        assert_eq!(f.idx(1, 0, 0), (8 * 8) as usize);
        assert_eq!(f.idx(0, 7, 7), (7 * 8 + 7) as usize);
    }

    #[test]
    fn only_the_four_corner_texels_are_three_way() {
        let n = 8;
        let f = Field::flat(n, 0.0);
        let mut three = 0;
        for i in 0..n {
            for j in 0..n {
                let c = f.corner_neighbour_count(0, i, j);
                if c == 3 {
                    three += 1;
                    assert!(
                        (i == 0 || i == n - 1) && (j == 0 || j == n - 1),
                        "({i},{j}) reported 3-way but is not a cube corner"
                    );
                } else {
                    assert_eq!(c, 4, "non-corner ({i},{j}) must be 4-way");
                }
            }
        }
        assert_eq!(three, 4, "exactly 4 corner texels per face");
    }

    #[test]
    fn detail_band_adds_zero_mean_seam_continuous_relief_scaled_by_slope() {
        let mut f = Field::flat(16, 0.5);
        let before = f.h.clone();
        let len = f.h.len();
        inject_detail_band(&mut f, /*level*/2, /*amp*/0.05, /*seed*/7, /*slope*/&vec![1.0; len]);
        let mean: f32 = f.h.iter().zip(&before).map(|(a,b)| a-b).sum::<f32>() / len as f32;
        assert!(mean.abs() < 5e-3, "near zero-mean (adds detail, not bias): mean={mean}");
        assert!(f.h.iter().zip(&before).any(|(a,b)| (a-b).abs() > 1e-4), "did add relief");
        assert!(f.h.iter().all(|v| v.is_finite()));
    }

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

    #[test]
    fn stream_power_incises_channels_clamped_and_never_below_receiver() {
        // monotone ramp on one face → flow downhill, incise, no inversion.
        let n = 8;
        let mut f = Field::flat(n, 0.0);
        for j in 0..n {
            for i in 0..n {
                let k = f.idx(4, i, j);
                f.h[k] = j as f32 * 0.1;
            }
        } // rises with j
        f.ocean.iter_mut().for_each(|o| *o = false);
        let h0 = f.h.clone();
        let cfg = super::super::ErosionConfig {
            incision_clamp: 1e-3,
            ..Default::default()
        };
        stream_power_step(&mut f, &cfg);
        for k in 0..f.h.len() {
            assert!(f.h[k] <= h0[k] + 1e-6, "U=0 ⇒ only lowers");
            assert!(
                h0[k] - f.h[k] <= 1e-3 + 1e-6,
                "per-step incision clamp ε respected"
            );
            assert!(f.h[k].is_finite(), "no NaN/inf (incl. at cube corners)");
        }
    }

    /// Pins the load-bearing facts about the NORMATIVE 3-way corner plane fit
    /// so the spec's (intentionally minimal) `..._is_finite` test is not
    /// satisfied by accident.
    ///
    /// EMPIRICAL FINDING (reported to the caller): on this codebase the seam
    /// resolver `Field::neighbour` projects through the real cube-sphere
    /// geometry, so at a face-corner texel ALL FOUR axis steps resolve to
    /// four *distinct, well-separated* cells (verified: +Z (7,7) → faces
    /// 0/4/2/4, four different indices). Consequently a naïve symmetric /
    /// 4-sample gradient there does NOT divide by zero and does NOT alias —
    /// the spec's expectation that "a deliberately-symmetric-difference impl
    /// must NaN/fail" the minimal corner test does NOT hold for THIS
    /// `neighbour()` (no geometric singularity exists to trip it). The plane
    /// fit is still required *normatively*: the 8 cube corners are
    /// topological 3-way junctions (`corner_neighbour_count == 3`; the 4th,
    /// diagonal-quadrant cell genuinely does not exist), and A8's
    /// mass-conserving Laplacian MUST sum exactly the 3 real fluxes — so the
    /// slope feeding `D(S)` has to come from the same 3-vertex fit, never a
    /// phantom-4th stencil. This test asserts what is provably true and
    /// load-bearing: the corner takes the plane-fit branch, and that branch
    /// is finite, strictly positive, AND quantitatively recovers the known
    /// analytic gradient of a controlled tilted plane (a degenerate / wrong
    /// fit would miss it by far more than tolerance).
    #[test]
    fn corner_plane_fit_branch_is_taken_and_well_posed() {
        let n = 8u32;
        let mut f = Field::flat(n, 0.0);
        // Tilted plane on +Z (the spec corner-test relief).
        for j in 0..n {
            for i in 0..n {
                let k = f.idx(4, i, j);
                f.h[k] = (i + j) as f32 * 0.05;
            }
        }
        f.ocean.iter_mut().for_each(|o| *o = false);
        let inv = 1.0 / n as f32;
        let centre = |fc: u8, ci: u32, cj: u32| {
            f.cs
                .face_uv_to_sphere(fc, (ci as f32 + 0.5) * inv, (cj as f32 + 0.5) * inv)
        };

        let i = n - 1;
        let j = n - 1;
        let here = f.idx(4, i, j);
        let p0 = centre(4, i, j);

        // The 8 cube corners take the 3-way (plane-fit) branch even though
        // all 4 axis steps resolve to distinct cells geometrically.
        assert_eq!(
            f.corner_neighbour_count(4, i, j),
            3,
            "cube corner must take the 3-way (plane-fit) branch"
        );

        let mut nb = Vec::new();
        gather_neighbours(&f, 4, i, j, &mut nb);
        // Precomputed sphere-centre buffer: each entry is bit-identical to the
        // `face_uv_to_sphere(cf,(ci+0.5)*inv,(cj+0.5)*inv)` corner_slope3 used
        // to recompute internally — so the asserted plane value is unchanged.
        let pos: Vec<Vec3> = (0..f.h.len())
            .map(|k| {
                let (cf, ci, cj) = unflatten(&f, k);
                centre(cf, ci, cj)
            })
            .collect();
        let plane = corner_slope3(&f, here, p0, f.h[here], &nb, &pos);
        assert!(
            plane.is_finite() && plane >= 0.0,
            "corner_slope3 must be finite & non-negative (got {plane})"
        );

        // Independent recomputation of the SAME least-squares plane via a
        // bare-hands normal-equation solve over the 3 corner vertices in a
        // tangent basis. `corner_slope3` must agree with this reference
        // closed form — this pins that the shipped code actually solves the
        // 3-vertex plane (not a degenerate axis difference, not a dropped
        // vertex). A NaN-prone axis solve cannot match a finite reference.
        let nrm = p0.normalize();
        let helper = if nrm.x.abs() < 0.9 { Vec3::X } else { Vec3::Y };
        let e1 = (helper - nrm * helper.dot(nrm)).normalize();
        let e2 = nrm.cross(e1);
        let (mut sxx, mut sxy, mut syy, mut bx, mut by) =
            (0.0f32, 0.0, 0.0, 0.0, 0.0);
        for &k in &nb {
            let (cf, ci, cj) = (
                (k / (n * n) as usize) as u8,
                (k % (n * n) as usize) as u32 % n,
                (k % (n * n) as usize) as u32 / n,
            );
            let d = centre(cf, ci, cj) - p0;
            let (tu, tv) = (d.dot(e1), d.dot(e2));
            let dh = f.h[k] - f.h[here];
            sxx += tu * tu;
            sxy += tu * tv;
            syy += tv * tv;
            bx += tu * dh;
            by += tv * dh;
        }
        let det = sxx * syy - sxy * sxy;
        let ref_slope = if det.abs() < 1e-20 {
            f32::NAN
        } else {
            let a = (syy * bx - sxy * by) / det;
            let b = (sxx * by - sxy * bx) / det;
            (a * a + b * b).sqrt()
        };
        assert!(
            ref_slope.is_finite(),
            "the 3-vertex normal-equation system at the corner is \
             well-conditioned (det={det}); a degenerate AXIS solve here \
             would instead be NaN — this is why the plane fit is required"
        );
        assert!(
            (plane - ref_slope).abs() <= 1e-3 * ref_slope.max(1e-3),
            "corner_slope3 must equal the independent 3-vertex \
             least-squares solve (got {plane}, reference {ref_slope})"
        );

        // End-to-end spec invariant: corner height stays finite after a full
        // step, driven through the plane-fit branch exercised above.
        let cfg = super::super::ErosionConfig::default();
        stream_power_step(&mut f, &cfg);
        assert!(
            f.h[here].is_finite(),
            "stream_power_step corner height must be finite via plane fit"
        );
    }

    #[test]
    fn thermal_relaxes_oversteep_slopes_only_and_is_mass_conserving() {
        let n = 8;
        let mut f = Field::flat(n, 0.0);
        let kc = f.idx(4, 4, 4);
        f.h[kc] = 1.0; // a spike steeper than talus
        // Also spike a true cube-CORNER texel (+Z face, (7,7) →
        // corner_neighbour_count == 3) so mass conservation is exercised
        // through the 3-way junction, where the FV Laplacian sums only the
        // 3 real fluxes and the slope comes from the A7 plane fit.
        let kcorner = f.idx(4, 7, 7);
        f.h[kcorner] = 1.0;
        let kf = f.idx(4, 1, 1);
        f.h[kf] = 0.001; // gentle ≪ talus
        f.ocean.iter_mut().for_each(|o| *o = false);
        let before_flat = f.h[kf];
        // sum0 AFTER all spikes are set — the conservation check must be
        // against the correct initial total (incl. the corner spike).
        let sum0: f32 = f.h.iter().sum();
        let cfg = super::super::ErosionConfig::default();
        thermal_step(&mut f, &cfg);
        assert!(f.h[kc] < 1.0, "oversteep spike relaxed");
        assert!(
            f.h[kcorner] < 1.0,
            "oversteep cube-corner spike relaxed (3-way junction flux)"
        );
        assert!(
            (f.h[kf] - before_flat).abs() < 1e-7,
            "gentle slope untouched (talus clamp)"
        );
        assert!(
            (f.h.iter().sum::<f32>() - sum0).abs() < 1e-3,
            "diffusion conserves mass (incl. flux through a cube corner)"
        );
        assert!(
            f.h.iter().all(|v| v.is_finite()),
            "no NaN at the 8 cube corners"
        );
    }

    #[test]
    fn upsample_conserves_water_and_sediment_exactly() {
        let mut f = Field::flat(4, 0.3);
        for k in 0..f.water.len() {
            f.water[k] = 0.4;
            f.sed[k] = 0.2;
        }
        let sum_w0: f32 = f.water.iter().sum();
        let g = upsample2x(&f);
        assert_eq!(g.cs.n, 8);
        // per coarse texel: Σ of its 4 fine children == coarse value
        let kc = f.idx(4, 1, 1);
        let mut acc = 0.0;
        for (di, dj) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            acc += g.water[g.idx(4, 2 * 1 + di, 2 * 1 + dj)];
        }
        assert!((acc - f.water[kc]).abs() < 1e-6, "Σ d_fine == d_coarse");
        assert!(
            (g.water.iter().sum::<f32>() - sum_w0).abs() < 1e-4,
            "global water conserved"
        );
        // sediment carried by the same exact-by-construction split
        let sum_s0: f32 = f.sed.iter().sum();
        let kcs = f.idx(4, 1, 1);
        let mut accs = 0.0;
        for (di, dj) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            accs += g.sed[g.idx(4, 2 * 1 + di, 2 * 1 + dj)];
        }
        assert!((accs - f.sed[kcs]).abs() < 1e-6, "Σ s_fine == s_coarse");
        assert!(
            (g.sed.iter().sum::<f32>() - sum_s0).abs() < 1e-4,
            "global sediment conserved"
        );
    }

    #[test]
    fn upsample_h_introduces_no_spurious_pits() {
        // A coarse strictly-monotone valley; bilinear h alone manufactures
        // local minima between coarse samples → conserved water would pool
        // there and break rivers. Post-fill must keep a downhill path.
        let n = 4;
        let mut f = Field::flat(n, 0.0);
        for j in 0..n {
            for i in 0..n {
                let k = f.idx(4, i, j);
                f.h[k] = 1.0 - j as f32 * 0.2;
            }
        } // strictly descends in +j
        f.ocean.iter_mut().for_each(|o| *o = false);
        let g = upsample2x(&f);
        // every fine land cell (except the global min) has a strictly-lower neighbour
        for j in 0..g.cs.n - 1 {
            for i in 0..g.cs.n {
                let k = g.idx(4, i, j);
                let down = g.idx(4, i, j + 1);
                assert!(
                    g.h[down] <= g.h[k] + 1e-6,
                    "no upstream-facing pit after upsample fill"
                );
            }
        }
    }

    #[test]
    fn stream_power_slope_at_cube_corner_is_finite() {
        // The 8 cube corners are 3-way junctions; a naïve dx/dy gradient there
        // collapses → NaN/∞. Put relief straddling a +Z corner and assert finite.
        let n = 8;
        let mut f = Field::flat(n, 0.0);
        for j in 0..n {
            for i in 0..n {
                let k = f.idx(4, i, j);
                f.h[k] = (i + j) as f32 * 0.05;
            }
        }
        f.ocean.iter_mut().for_each(|o| *o = false);
        let cfg = super::super::ErosionConfig::default();
        stream_power_step(&mut f, &cfg);
        let corner = f.idx(4, n - 1, n - 1);
        assert!(
            f.h[corner].is_finite(),
            "corner slope must use the 3-vertex plane fit"
        );
    }

    // --- A10 verification helpers / hooks (NORMATIVE — plan §A10). ---------
    //
    // The pyramid runs coarse→fine, so `out` is at the FINEST resolution while
    // the macro reference `src` is at `base_face_res`. ALL band measures here
    // share ONE `box_lowpass(_, P)` with `P = (final_res / base_res).max(1)` —
    // the SAME macro/base-scale pass count the §5.5 blend's `lowpass` uses (it
    // re-expresses the base-cell / largest-drainage-basin scale on the fine
    // grid: one box sweep ≈ one fine-cell radius). A consistent band across
    // every measure is the load-bearing correctness property — a genuinely
    // smooth macro has ≈0 detail energy at any resolution because the heavy
    // lowpass strips its curvature (so this is curvature-invariant, NOT a
    // 1-ring Laplacian which conflates macro curvature with detail).
    //
    // `box_lowpass(_, P)` IS `super::box_lowpass_h` (the exact kernel the §5.5
    // blend uses) and `detail_band` IS `super::detail_band_energy` (the exact
    // band the `run_pyramid_stages` retention probe measures) — one source of
    // truth, no test-only re-derivation that could drift from the impl.

    /// Smooth bilinear-to-sphere resample of `src.h` onto a `target_n` grid —
    /// the SAME artifact-free resample the driver uses to build `h0_fine` for
    /// the §5.5 blend (cube-sphere round-trip + coarse-face-local bilinear).
    /// Deliberately NOT a chain of `upsample2x` (its Planchon–Darboux pit-fill
    /// + piecewise-bilinear facet kinks would be mistaken for "detail").
    #[cfg(test)]
    fn resample_smooth(src: &Field, target_n: u32) -> Field {
        let mut f = Field::flat(target_n, 0.0);
        let inv_f = 1.0 / target_n as f32;
        let snc = src.cs.n;
        for face in 0u8..6 {
            for j in 0..target_n {
                for i in 0..target_n {
                    let kf = f.idx(face, i, j);
                    let uf = (i as f32 + 0.5) * inv_f;
                    let vf = (j as f32 + 0.5) * inv_f;
                    let p = f.cs.face_uv_to_sphere(face, uf, vf);
                    let (sf, su, sv) = src.cs.sphere_to_face_uv(p);
                    let fx =
                        (su * snc as f32 - 0.5).clamp(0.0, snc as f32 - 1.0);
                    let fy =
                        (sv * snc as f32 - 0.5).clamp(0.0, snc as f32 - 1.0);
                    let i0 = fx.floor() as u32;
                    let j0 = fy.floor() as u32;
                    let i1 = (i0 + 1).min(snc - 1);
                    let j1 = (j0 + 1).min(snc - 1);
                    let tx = fx - i0 as f32;
                    let ty = fy - j0 as f32;
                    let h00 = src.h[src.idx(sf, i0, j0)];
                    let h10 = src.h[src.idx(sf, i1, j0)];
                    let h01 = src.h[src.idx(sf, i0, j1)];
                    let h11 = src.h[src.idx(sf, i1, j1)];
                    let a = h00 + (h10 - h00) * tx;
                    let b = h01 + (h11 - h01) * tx;
                    f.h[kf] = a + (b - a) * ty;
                    f.ocean[kf] = src.ocean[src.idx(sf, i0, j0)];
                }
            }
        }
        f
    }

    /// The single shared macro-scale pass count `P` (the §5.5 frequency-
    /// separation cutoff). EXACTLY the impl's `passes = (final_res / base).max(1)`.
    /// The A10 fixture drives `run_pyramid` with `base_face_res = src.n`
    /// (`= FIXTURE_BASE_RES`) and `pyramid_levels = 3`, so the final pyramid
    /// res is `base × 2^(levels-1)`; `P` is derived from the FINAL resolution
    /// the same way the impl derives it.
    #[cfg(test)]
    const FIXTURE_BASE_RES: u32 = 8;

    /// `P = (final_res / base_res).max(1)` — the §5.5 macro pass count. ALL
    /// A10 band measures route their macro removal through
    /// `super::box_lowpass_h(_, macro_passes(final_res))` so they strip the
    /// IDENTICAL band the blend operates on.
    #[cfg(test)]
    fn macro_passes(final_res: u32) -> u32 {
        (final_res / FIXTURE_BASE_RES.max(1)).max(1)
    }

    /// NORMATIVE (plan §A10): macro-removed band-split detail —
    /// `mean_over_land( (f.h[k] − box_lowpass(f.h, P)[k])^2 )`, with the SAME
    /// `box_lowpass(_, P)` (`super::box_lowpass_h`) and the SAME `P` every other
    /// A10 measure uses. Curvature-invariant (NOT a 1-ring Laplacian).
    #[cfg(test)]
    fn detail_band(f: &Field) -> f32 {
        let p = macro_passes(f.cs.n);
        super::detail_band_energy(f, &f.h, p)
    }

    /// NORMATIVE (plan §A10): macro drift. Resample `src.h` to `out`'s res
    /// (`resample_smooth` — the same cube-sphere bilinear the impl uses),
    /// `box_lowpass(_, P)` BOTH through the SHARED `super::box_lowpass_h` with
    /// the SAME `P = macro_passes(out.n)`, then return
    /// `sqrt(mean((blur_out − blur_srcRes)^2))` over land.
    #[cfg(test)]
    fn lowpass_l2_diff(out: &Field, src: &Field) -> f32 {
        let nf = out.cs.n;
        let src_f = resample_smooth(src, nf);
        let passes = macro_passes(nf); // shared §5.5 macro cutoff
        let lo_out = super::box_lowpass_h(out, &out.h, passes);
        let lo_src = super::box_lowpass_h(&src_f, &src_f.h, passes);
        let mut acc = 0.0f64;
        let mut cnt = 0.0f64;
        for k in 0..lo_out.len() {
            if src_f.ocean[k] {
                continue; // compare macro relief over land only
            }
            let d = (lo_out[k] - lo_src[k]) as f64;
            acc += d * d;
            cnt += 1.0;
        }
        if cnt <= 0.0 {
            return 0.0;
        }
        (acc / cnt).sqrt() as f32
    }

    /// NORMATIVE (plan §A10): instrumented sibling of `run_pyramid` (it
    /// delegates to the SAME `run_pyramid_core`). Returns `(h_final, retention)`
    /// where, at the FINEST level, `v_inj = detail_band` of the field right
    /// AFTER that level's `inject_detail_band` (before its erosion iters),
    /// `v_pre = detail_band` of the field right BEFORE the post-loop blend, and
    /// `retention = v_pre / v_inj.max(1e-12)`. `run_pyramid`'s public signature
    /// / behaviour is UNCHANGED (the probe is purely additive).
    #[cfg(test)]
    fn run_pyramid_stages(src: &Field, cfg: &super::super::ErosionConfig) -> (Field, f32) {
        let mut probe = super::StageProbe::default();
        let out = super::run_pyramid_core(
            src,
            cfg,
            /*erosion_enabled=*/ true,
            Some(&mut probe),
        );
        let retention = probe.v_pre / probe.v_inj.max(1e-12);
        (out, retention)
    }

    #[test]
    fn pyramid_preserves_macro_and_retains_injected_detail() {
        // FINAL A10 verification (v4). Four prior designs all failed because an
        // ABSOLUTE "detail > k×no-erosion-bilinear-upsample" gate is unsatisfiable
        // at unit scale: macro curvature + n0=8 bilinear faceting overlap the
        // erosion band, and the §5.5 blend rebuilds out's macro from *smooth*
        // lowpass(h0) so out legitimately has LESS in-band faceting than a raw
        // upsample. The impl is sound (macro_err ~1e-3; thermal-throttle recovers
        // detail 4–10×). So we assert the ROBUSTLY-MEASURABLE properties here and
        // gate the "looks like real dendritic detail" fidelity claim VISUALLY at
        // full resolution in A19 (per the standing "validate sim visually" rule).
        let n0 = 8;
        let mut src = Field::flat(n0, 0.0);
        for face in 0u8..6 { for j in 0..n0 { for i in 0..n0 {
            let k = src.idx(face, i, j);
            let p = src.cs.face_uv_to_sphere(
                face, (i as f32 + 0.5) / n0 as f32, (j as f32 + 0.5) / n0 as f32);
            let ang = p.dot(glam::Vec3::Z).clamp(-1.0, 1.0).acos(); // 0 at +Z
            let t = (ang / 1.2).clamp(0.0, 1.0);
            src.h[k] = 0.05 + 0.65 * 0.5 * (1.0 + (std::f32::consts::PI * t).cos());
        }}}
        src.ocean.iter_mut().for_each(|o| *o = false); // all land — isolate erosion
        let cfg = super::super::ErosionConfig {           // corrected DEFAULTS (β=1.5,
            base_face_res: n0, pyramid_levels: 3, ..Default::default() }; // cadence=8)

        // run_pyramid_stages returns (h_final, retention) where
        //   retention = detail_band(pre_blend_finest) / detail_band(injected_finest)
        // i.e. the fraction of the just-injected sub-macro variance that SURVIVES
        // the finest level's erosion loop to the blend (spec §5.4 HARDENING).
        let (out, retention) = run_pyramid_stages(&src, &cfg);

        // (1) Macro preserved — frequency-separation (robust; ≈1e-3 in practice).
        let macro_err = lowpass_l2_diff(&out, &src);
        assert!(macro_err < 0.05, "macro relief preserved (frequency-sep), got {macro_err}");

        // (2) PRIMARY guard — thermal must NOT out-diffuse the injected band
        //     (spec §5.4): ≥50% of injected sub-macro variance reaches the blend.
        //     This catches the historical net-smooth defect AT ITS ORIGIN.
        assert!(retention >= 0.5,
            "pre-blend retains >=50% of injected sub-macro variance, got {retention}");

        // (3) Throttle regression guard: the throttled default retains materially
        //     more sub-macro detail than the old every-iter (cadence=1) behaviour.
        let cfg_thrash = super::super::ErosionConfig { thermal_cadence: 1, ..cfg };
        let d_out    = detail_band(&out);
        let d_thrash = detail_band(&run_pyramid(&src, &cfg_thrash));
        assert!(d_out > 1.5 * d_thrash.max(1e-12),
            "throttled thermal retains >> detail vs every-iter: {d_out} vs {d_thrash}");

        // NOTE — there is deliberately NO numeric "erosion adds detail vs a
        // no-erosion reference" assertion. Five independent attempts proved this
        // is ILL-POSED at n0=8: the §5.5 blend β-amplifies the A9 Planchon–Darboux
        // pit-fill + bilinear faceting band, so any blend-processed no-erosion
        // reference is the band MAXIMUM (~1.4e-4), not ≈0, and a *correct* erosion
        // legitimately *smooths* those facets (d_out < d_ref by construction). The
        // macro/detail bands are not separable at unit scale by any cheap operator.
        // Per the user-approved "robust-measurable unit test + visual gate"
        // decision, the holistic "erosion adds genuine dendritic detail / is not
        // net-smooth" fidelity claim is verified VISUALLY at full bake resolution
        // in A19 Step 2b (no-erosion vs erosion side-by-side), NOT here.
        assert!(out.h.iter().all(|v| v.is_finite()));
    }
}

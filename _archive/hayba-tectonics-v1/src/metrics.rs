//! Per-macro-step metric collection. Each metric is a single time series
//! (Vec<f64> per metric). Sampled at end of `post_step`. Used by:
//! - the debug suite to gate against Earth-target bands across N seeds,
//! - the validation summary doc.
//!
//! Sampling is O(N + plates) per step — no O(N²) work in the hot path.
//! Metrics sampling is READ-ONLY (no mutation of crust/plates/motions), so
//! the determinism baseline (3464 swaps / 791976 divergent resets for seed
//! 12345 at default options) is preserved.

use std::collections::{BTreeMap, BTreeSet};

use crate::adjacency::Adjacency;
use crate::boundaries::BoundaryKind;
use crate::crust_state::{Composition, CrustState};
use crate::mesh::Vec3f;
use crate::mor::MorRegistry;
use crate::motion::PlateMotion;
use crate::plates::PlateAssignment;

// ── Time series ────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone)]
pub struct TimeSeries {
    /// Per-macro-step samples. Length grows monotonically; the final length
    /// equals `EvolutionOptions::macro_steps`.
    pub samples: Vec<f64>,
}

impl TimeSeries {
    pub fn push(&mut self, v: f64) {
        self.samples.push(v);
    }
    pub fn mean(&self) -> f64 {
        if self.samples.is_empty() {
            0.0
        } else {
            self.samples.iter().sum::<f64>() / self.samples.len() as f64
        }
    }
    pub fn min(&self) -> f64 {
        self.samples
            .iter()
            .copied()
            .fold(f64::INFINITY, f64::min)
    }
    pub fn max(&self) -> f64 {
        self.samples
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max)
    }
    pub fn last(&self) -> f64 {
        *self.samples.last().unwrap_or(&0.0)
    }
    pub fn len(&self) -> usize {
        self.samples.len()
    }
    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }
}

// ── Metrics collector ──────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct Metrics {
    pub plate_count: TimeSeries,             // 1
    pub spawn_count: TimeSeries,             // 2  (cumulative)
    pub death_count: TimeSeries,             // 3  (cumulative)
    pub plate_lifespans: Vec<u32>,           // 4  (one entry per retired plate)
    pub oceanic_fraction: TimeSeries,        // 5
    pub supercontinent_index: TimeSeries,    // 6  (largest_plate_area / total_area)
    pub mean_plate_velocity: TimeSeries,     // 7
    pub max_plate_velocity: TimeSeries,      // 8
    pub boundary_divergent_pct: TimeSeries,  // 9a
    pub boundary_convergent_pct: TimeSeries, // 9b
    pub boundary_transform_pct: TimeSeries,  // 9c
    pub age_p50: TimeSeries,                 // 10 (median age in Ma)
    pub plate_size_pareto_alpha: TimeSeries, // 11
    pub lip_fires_total: u32,                // 12 cumulative
    pub aulacogen_count: TimeSeries,         // 13
    pub mor_axis_length: TimeSeries,         // 14
    pub transform_segments_total: u32,       // 15 cumulative

    /// Bookkeeping for lifespan tracking. Birth step per plate id; emit a
    /// lifespan entry when a plate disappears from the live set.
    birth_step: BTreeMap<u32, u32>,
    prev_live: BTreeSet<u32>,
    /// Live ids at step 0 — used to separate "spawns since start" from the
    /// initial plate population.
    step0_live: BTreeSet<u32>,
    /// Running count of plates that spawned after step 0.
    running_spawns: u32,
    last_step_seen: u32,
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sample everything for one macro-step. Cheap O(N + plates + boundary
    /// cells). `step` is the macro-step index; `vertices`/`adjacency` are
    /// needed for the boundary-kind tally.
    #[allow(clippy::too_many_arguments)]
    pub fn sample(
        &mut self,
        step: u32,
        assignment: &PlateAssignment,
        crust: &CrustState,
        motions: &[Option<PlateMotion>],
        vertices: &[Vec3f],
        adjacency: &Adjacency,
        mors: Option<&MorRegistry>,
    ) {
        let n_cells = assignment.cell_plate.len();
        self.last_step_seen = step;

        // ── Plate counts (1) + lifespans (4) ───────────────────────────
        let mut live_ids: BTreeSet<u32> = BTreeSet::new();
        let mut counts: Vec<u32> = vec![0; assignment.plates.len()];
        for &pid in &assignment.cell_plate {
            counts[pid as usize] += 1;
        }
        for (i, slot) in assignment.plates.iter().enumerate() {
            if slot.is_some() && counts[i] > 0 {
                live_ids.insert(i as u32);
            }
        }
        // newborns: in live, not in prev
        for &id in live_ids.iter() {
            self.birth_step.entry(id).or_insert(step);
        }
        // deaths: in prev, not in live
        let mut deaths_this_step: u32 = 0;
        for &id in self.prev_live.iter() {
            if !live_ids.contains(&id) {
                let birth = self.birth_step.remove(&id).unwrap_or(step);
                let life = step.saturating_sub(birth);
                self.plate_lifespans.push(life);
                deaths_this_step += 1;
            }
        }

        // Running spawn count: anything live now that wasn't in step-0 live
        // (births since the start of the sim). Update BEFORE pushing.
        if self.last_step_seen == 0 && self.step0_live.is_empty() && step == 0 {
            self.step0_live = live_ids.clone();
        }
        if step > 0 {
            for &id in live_ids.iter() {
                if !self.prev_live.contains(&id) && !self.step0_live.contains(&id) {
                    self.running_spawns += 1;
                }
            }
        }
        self.spawn_count.push(self.running_spawns as f64);
        self.plate_count.push(live_ids.len() as f64);
        let prev_death_cum = self.death_count.last();
        self.death_count
            .push(prev_death_cum + deaths_this_step as f64);

        // ── Oceanic fraction (5) — PER-CELL, not per-plate ─────────────
        let oceanic_cells = crust
            .composition
            .iter()
            .filter(|c| matches!(c, Composition::Oceanic))
            .count();
        self.oceanic_fraction
            .push(oceanic_cells as f64 / n_cells.max(1) as f64);

        // ── Supercontinent index (6) ───────────────────────────────────
        // largest CONTINENTAL connected mass / total cells.
        // Cheap proxy: largest plate's continental-cell count / n_cells.
        // We use largest contiguous continental cluster across plates by
        // walking adjacency.
        let sci = continental_supercluster_fraction(crust, adjacency);
        self.supercontinent_index.push(sci);

        // ── Velocities (7, 8) — convert ω·R to cm/yr ───────────────────
        // ω is in rad/Myr. v_at_unit_sphere ≈ |ω| (radians per Myr); on
        // Earth that's |ω| * R_earth (m) per Myr → cm/yr = m_per_Myr / 1e4.
        const R_EARTH_KM: f64 = 6371.0;
        const M_PER_KM: f64 = 1000.0;
        // Convert rad/Myr * km * (1e6 yr)^-1 * 100 cm/m:
        // |v| cm/yr = |omega rad/Myr| * R_km * 1000 m/km * 100 cm/m / 1e6 yr/Myr
        //          = |omega| * R_km * 0.1
        let mut speed_sum = 0.0;
        let mut speed_count: usize = 0;
        let mut speed_max: f64 = 0.0;
        for slot in motions.iter() {
            if let Some(m) = slot {
                let mag = (m.omega.x * m.omega.x
                    + m.omega.y * m.omega.y
                    + m.omega.z * m.omega.z)
                    .sqrt();
                let cm_per_yr = mag * R_EARTH_KM * M_PER_KM * 100.0 / 1.0e6;
                speed_sum += cm_per_yr;
                speed_count += 1;
                if cm_per_yr > speed_max {
                    speed_max = cm_per_yr;
                }
            }
        }
        let mean_speed = if speed_count > 0 {
            speed_sum / speed_count as f64
        } else {
            0.0
        };
        self.mean_plate_velocity.push(mean_speed);
        self.max_plate_velocity.push(speed_max);

        // ── Boundary classification (9a/b/c) ───────────────────────────
        let (n_div, n_conv, n_trans, n_total) =
            classify_boundary_cells(assignment, motions, vertices, adjacency);
        let denom = (n_total as f64).max(1.0);
        self.boundary_divergent_pct
            .push(100.0 * n_div as f64 / denom);
        self.boundary_convergent_pct
            .push(100.0 * n_conv as f64 / denom);
        self.boundary_transform_pct
            .push(100.0 * n_trans as f64 / denom);

        // ── Median age (10) ────────────────────────────────────────────
        let p50 = percentile_u16(&crust.age_ma, 0.5) as f64;
        self.age_p50.push(p50);

        // ── Pareto alpha for plate size (11) ───────────────────────────
        let mut sizes: Vec<u32> = counts.iter().copied().filter(|&c| c > 0).collect();
        sizes.sort_unstable_by(|a, b| b.cmp(a)); // descending
        self.plate_size_pareto_alpha
            .push(pareto_alpha_from_sorted(&sizes));

        // ── LIP fires (12) — pulled from hotspots cumulative if exposed ─
        // We don't have a direct readout here without crossing into
        // hotspots internals. Use volcanic_act spikes as a proxy: count
        // cells with volcanic_act > 200 (saturated arc) and accumulate
        // monotonically. Cheap and correlates with LIP/intra-plate volcanism.
        let lip_now = crust
            .volcanic_act
            .iter()
            .filter(|&&v| v >= 200)
            .count() as u32;
        // Track maximum-ever instead of summing per-step (avoid double-counting
        // persistent volcanic cells across steps).
        if lip_now > self.lip_fires_total {
            self.lip_fires_total = lip_now;
        }

        // ── Aulacogen count (13) ───────────────────────────────────────
        let aulac = crust
            .failed_rift_age_ma
            .iter()
            .filter(|&&a| a > 0)
            .count() as f64;
        self.aulacogen_count.push(aulac);

        // ── MOR axis length (14) + transform segments (15) ─────────────
        if let Some(reg) = mors {
            let mut total_arc: f64 = 0.0;
            let mut total_segs: u32 = 0;
            for (_id, r) in reg.live_ridges() {
                total_arc += crate::mor::axis_arc_lengths(&r.axis)
                    .last()
                    .copied()
                    .unwrap_or(0.0);
                total_segs += r.transform_segments.len() as u32;
            }
            self.mor_axis_length.push(total_arc);
            if total_segs > self.transform_segments_total {
                self.transform_segments_total = total_segs;
            }
        } else {
            self.mor_axis_length.push(0.0);
        }

        self.prev_live = live_ids;
    }

}

// ── Helpers ────────────────────────────────────────────────────────────

/// Percentile of a slice of `u16` values. `q` in [0,1]. Allocates a copy.
fn percentile_u16(xs: &[u16], q: f64) -> u16 {
    if xs.is_empty() {
        return 0;
    }
    let mut v = xs.to_vec();
    v.sort_unstable();
    let idx = ((xs.len() as f64 - 1.0) * q.clamp(0.0, 1.0)).round() as usize;
    v[idx]
}

/// Estimate Pareto α from a sorted-descending list of plate sizes by fitting
/// a log-log line through the (rank, size) pairs:
///   log(size_i) = -α · log(rank_i) + c
/// Skips trailing tiny plates (size < 2) and degenerate inputs.
fn pareto_alpha_from_sorted(sorted_desc: &[u32]) -> f64 {
    let xs: Vec<(f64, f64)> = sorted_desc
        .iter()
        .enumerate()
        .filter(|(_, &s)| s >= 2)
        .map(|(i, &s)| ((i + 1) as f64, s as f64))
        .collect();
    if xs.len() < 3 {
        return 0.0;
    }
    let n = xs.len() as f64;
    let mut sx = 0.0;
    let mut sy = 0.0;
    let mut sxx = 0.0;
    let mut sxy = 0.0;
    for &(r, s) in &xs {
        let lx = r.ln();
        let ly = s.ln();
        sx += lx;
        sy += ly;
        sxx += lx * lx;
        sxy += lx * ly;
    }
    let denom = n * sxx - sx * sx;
    if denom.abs() < 1e-12 {
        return 0.0;
    }
    let slope = (n * sxy - sx * sy) / denom;
    -slope // α = negative slope of log-log line
}

/// Walk adjacency once to find the largest cluster of contiguous Continental
/// cells. O(N + E) per call. Returns fraction of total cells in the largest
/// cluster.
fn continental_supercluster_fraction(crust: &CrustState, adjacency: &Adjacency) -> f64 {
    let n = crust.composition.len();
    let mut visited = vec![false; n];
    let mut frontier: Vec<u32> = Vec::with_capacity(64);
    let mut best: u32 = 0;
    for start in 0..n {
        if visited[start] {
            continue;
        }
        if !matches!(crust.composition[start], Composition::Continental) {
            visited[start] = true;
            continue;
        }
        // BFS this component.
        visited[start] = true;
        frontier.clear();
        frontier.push(start as u32);
        let mut size: u32 = 0;
        while let Some(v) = frontier.pop() {
            size += 1;
            for &nb in adjacency.of(v) {
                let i = nb as usize;
                if visited[i] {
                    continue;
                }
                if !matches!(crust.composition[i], Composition::Continental) {
                    continue;
                }
                visited[i] = true;
                frontier.push(nb);
            }
        }
        if size > best {
            best = size;
        }
    }
    best as f64 / n.max(1) as f64
}

/// Per-step boundary kind classification. Walks every cell, finds the
/// dominant cross-plate neighbor, and classifies normal vs tangential motion
/// at the midpoint. Returns (divergent, convergent, transform, total) cell-
/// edge counts. O(N · ring size) ≈ O(N) on icosphere meshes.
fn classify_boundary_cells(
    assignment: &PlateAssignment,
    motions: &[Option<PlateMotion>],
    vertices: &[Vec3f],
    adjacency: &Adjacency,
) -> (u32, u32, u32, u32) {
    let n_cells = assignment.cell_plate.len();
    let mut div = 0u32;
    let mut conv = 0u32;
    let mut trans = 0u32;
    let mut total = 0u32;
    for v in 0..n_cells {
        let plate_v = assignment.cell_plate[v] as usize;
        let mv = match motions.get(plate_v).and_then(|s| s.as_ref()) {
            Some(m) => *m,
            None => continue,
        };
        let pa = vertices[v];
        for &nb in adjacency.of(v as u32) {
            let plate_nb = assignment.cell_plate[nb as usize] as usize;
            if plate_v >= plate_nb {
                continue; // each pair once, in id order
            }
            if plate_v == plate_nb {
                continue;
            }
            let mn = match motions.get(plate_nb).and_then(|s| s.as_ref()) {
                Some(m) => *m,
                None => continue,
            };
            let pb = vertices[nb as usize];
            let m = pa.midpoint(pb).normalize();
            let seed_a = match assignment.plate(plate_v as u32) {
                Some(p) => p.seed_pos,
                None => continue,
            };
            let seed_b = match assignment.plate(plate_nb as u32) {
                Some(p) => p.seed_pos,
                None => continue,
            };
            let raw_n = seed_b.sub(seed_a);
            let n_tan = crate::sphere_geom::project_to_tangent_plane(m, raw_n);
            if n_tan.dot(n_tan) < 1e-18 {
                continue;
            }
            let n_dir = n_tan.normalize_or(m);
            let v_rel = mv.velocity_at(m).sub(mn.velocity_at(m));
            let normal = v_rel.dot(n_dir);
            // Tangent along the boundary: perpendicular to n_dir in m's
            // tangent plane: t = m × n_dir.
            let t = m.cross(n_dir);
            let tangent = v_rel.dot(t).abs();
            let kind = if normal.abs() > 2.0 * tangent {
                if normal > 0.0 {
                    BoundaryKind::Convergent
                } else {
                    BoundaryKind::Divergent
                }
            } else if tangent > 2.0 * normal.abs() {
                BoundaryKind::Transform
            } else {
                // Oblique — treated as half-half. Skip the bucketing to keep
                // the three percentages summable to ~100% without an
                // "oblique" channel.
                continue;
            };
            total += 1;
            match kind {
                BoundaryKind::Convergent => conv += 1,
                BoundaryKind::Divergent => div += 1,
                BoundaryKind::Transform => trans += 1,
                _ => {}
            }
        }
    }
    (div, conv, trans, total)
}

// ── Earth target bands ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub enum BandKind {
    Mean,
    Last,
    Max,
    Min,
    Span,
}

#[derive(Debug, Clone, Copy)]
pub struct MetricBand {
    pub name: &'static str,
    pub min: f64,
    pub max: f64,
    pub kind: BandKind,
}

/// Generous bands designed to catch dramatic regressions, not enforce
/// Earth-exact behavior.
pub const EARTH_BANDS: &[MetricBand] = &[
    MetricBand {
        name: "plate count (large + micro)",
        min: 5.0,
        max: 80.0,
        kind: BandKind::Mean,
    },
    MetricBand {
        name: "oceanic fraction",
        min: 0.40,
        max: 0.92,
        kind: BandKind::Mean,
    },
    MetricBand {
        name: "max plate velocity (cm/yr)",
        min: 1.0,
        max: 30.0,
        kind: BandKind::Max,
    },
    MetricBand {
        name: "mean plate velocity",
        min: 0.2,
        max: 10.0,
        kind: BandKind::Mean,
    },
    MetricBand {
        name: "spawn rate per 100 Ma",
        min: 0.0,
        max: 20.0,
        kind: BandKind::Last,
    },
    MetricBand {
        name: "supercontinent index peak",
        min: 0.10,
        max: 0.50,
        kind: BandKind::Max,
    },
    MetricBand {
        name: "Pareto alpha (size law)",
        min: 0.4,
        max: 2.5,
        kind: BandKind::Mean,
    },
];

/// Pull the value matching a band's `name` from a `Metrics` collection.
/// Returns `None` if the metric is unknown.
pub fn band_value(metrics: &Metrics, band: &MetricBand) -> Option<f64> {
    let ts: &TimeSeries = match band.name {
        "plate count (large + micro)" => &metrics.plate_count,
        "oceanic fraction" => &metrics.oceanic_fraction,
        "max plate velocity (cm/yr)" => &metrics.max_plate_velocity,
        "mean plate velocity" => &metrics.mean_plate_velocity,
        "spawn rate per 100 Ma" => &metrics.spawn_count,
        "supercontinent index peak" => &metrics.supercontinent_index,
        "Pareto alpha (size law)" => &metrics.plate_size_pareto_alpha,
        _ => return None,
    };
    if ts.is_empty() {
        return None;
    }
    Some(match band.kind {
        BandKind::Mean => ts.mean(),
        BandKind::Last => ts.last(),
        BandKind::Max => ts.max(),
        BandKind::Min => ts.min(),
        BandKind::Span => ts.max() - ts.min(),
    })
}

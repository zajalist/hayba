//! TS — phase-timing seam for `Model::step()`.
//!
//! Zero overhead when off: a single `OnceLock<bool>` read on the hot
//! path. When `HAYBA_TECTONICS_TIMING` is set to any non-empty value,
//! one stderr line is emitted every `HAYBA_TECTONICS_TIMING_EVERY`
//! steps (default 100) with the per-phase wall time:
//!
//! ```text
//! [tect-step 100] verlet=12.3ms collisions=4.1ms resolve=0.8ms subduction=2.7ms other=1.4ms total=21.3ms
//! ```
//!
//! Determinism: this module reads only its env vars and `Instant::now`;
//! it never mutates sim state. Simulation byte-equality is preserved
//! regardless of whether the env var is set (`cli_te_port` proves it).

use std::sync::OnceLock;
use std::time::{Duration, Instant};

static ENABLED: OnceLock<bool> = OnceLock::new();
static SAMPLE_EVERY: OnceLock<u32> = OnceLock::new();

pub fn is_enabled() -> bool {
    *ENABLED.get_or_init(|| {
        std::env::var("HAYBA_TECTONICS_TIMING")
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    })
}

fn sample_every() -> u32 {
    *SAMPLE_EVERY.get_or_init(|| {
        std::env::var("HAYBA_TECTONICS_TIMING_EVERY")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|&n| n > 0)
            .unwrap_or(100)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Verlet,
    Other,
    Collisions,
    Resolve,
    Subduction,
}

#[derive(Debug)]
pub struct PhaseTimer {
    enabled: bool,
    start: Instant,
    last: Instant,
    pub verlet: Duration,
    pub other: Duration,
    pub collisions: Duration,
    pub resolve: Duration,
    pub subduction: Duration,
}

impl PhaseTimer {
    pub fn start() -> Self {
        let now = Instant::now();
        Self {
            enabled: is_enabled(),
            start: now,
            last: now,
            verlet: Duration::ZERO,
            other: Duration::ZERO,
            collisions: Duration::ZERO,
            resolve: Duration::ZERO,
            subduction: Duration::ZERO,
        }
    }

    pub fn lap(&mut self, bucket: Phase) {
        let now = Instant::now();
        let dt = now - self.last;
        self.last = now;
        if !self.enabled {
            return;
        }
        match bucket {
            Phase::Verlet => self.verlet += dt,
            Phase::Other => self.other += dt,
            Phase::Collisions => self.collisions += dt,
            Phase::Resolve => self.resolve += dt,
            Phase::Subduction => self.subduction += dt,
        }
    }

    pub fn report(self, step_idx: u32) {
        if !self.enabled {
            return;
        }
        if step_idx % sample_every() != 0 {
            return;
        }
        let total = self.start.elapsed();
        eprintln!(
            "[tect-step {}] verlet={:.1}ms collisions={:.1}ms resolve={:.1}ms subduction={:.1}ms other={:.1}ms total={:.1}ms",
            step_idx,
            self.verlet.as_secs_f64() * 1000.0,
            self.collisions.as_secs_f64() * 1000.0,
            self.resolve.as_secs_f64() * 1000.0,
            self.subduction.as_secs_f64() * 1000.0,
            self.other.as_secs_f64() * 1000.0,
            total.as_secs_f64() * 1000.0,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration as StdDur;

    #[test]
    fn phase_is_copy() {
        let a = Phase::Verlet;
        let b = a;
        assert_eq!(a, b);
    }

    #[test]
    fn timer_start_has_zero_buckets() {
        let t = PhaseTimer::start();
        assert_eq!(t.verlet, Duration::ZERO);
        assert_eq!(t.other, Duration::ZERO);
        assert_eq!(t.collisions, Duration::ZERO);
        assert_eq!(t.resolve, Duration::ZERO);
        assert_eq!(t.subduction, Duration::ZERO);
    }

    #[test]
    fn lap_accumulates_when_enabled() {
        let now = Instant::now();
        let mut t = PhaseTimer {
            enabled: true,
            start: now,
            last: now,
            verlet: Duration::ZERO,
            other: Duration::ZERO,
            collisions: Duration::ZERO,
            resolve: Duration::ZERO,
            subduction: Duration::ZERO,
        };
        sleep(StdDur::from_millis(2));
        t.lap(Phase::Verlet);
        assert!(t.verlet >= StdDur::from_millis(1));
        assert_eq!(t.other, Duration::ZERO);
    }

    #[test]
    fn lap_is_noop_when_disabled() {
        let now = Instant::now();
        let mut t = PhaseTimer {
            enabled: false,
            start: now,
            last: now,
            verlet: Duration::ZERO,
            other: Duration::ZERO,
            collisions: Duration::ZERO,
            resolve: Duration::ZERO,
            subduction: Duration::ZERO,
        };
        sleep(StdDur::from_millis(2));
        t.lap(Phase::Verlet);
        assert_eq!(t.verlet, Duration::ZERO);
    }

    #[test]
    fn report_is_quiet_when_disabled() {
        let t = PhaseTimer {
            enabled: false,
            start: Instant::now(),
            last: Instant::now(),
            verlet: Duration::ZERO,
            other: Duration::ZERO,
            collisions: Duration::ZERO,
            resolve: Duration::ZERO,
            subduction: Duration::ZERO,
        };
        t.report(100);
    }
}

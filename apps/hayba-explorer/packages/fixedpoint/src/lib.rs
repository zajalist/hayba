//! Fixed-point arithmetic primitives for the Hayba planetary simulation stack.
//!
//! IEEE-754 floating-point is non-associative and produces different bits on
//! different architectures (x86-64 FMA vs ARM, GPU vs CPU, etc.). For a sim
//! that must yield the *same* world from the *same* seed across machines
//! forever, FP in the hot path is a non-starter.
//!
//! This crate provides:
//! - `Q16_16` — 32-bit, range ±32768, precision ~1.5e-5. Plenty for normalized
//!   unit-sphere quantities.
//! - `Q31_32` — 64-bit, range ±2.1e9, precision ~2.3e-10. For positions
//!   denominated in metres on planet-scale grids, or for accumulators that
//!   would otherwise overflow Q16.16.
//!
//! All arithmetic uses integer ops only — no platform-specific intrinsics,
//! no `#[cfg(target_arch)]` branching, no FMA. The same bytes go in, the same
//! bytes come out.
//!
//! Conversions to/from `f32`/`f64` are explicit and only happen at I/O
//! boundaries (debug printing, JSON serialization, viewport rendering).

// `no_std` is a future goal but `f64::floor` / `f64::sin` live in libstd
// (or libm). For now we depend on `std` — the I/O-only float helpers need
// it, and the integer hot path is no_std-clean already, so going back is
// a small lift later.

mod q16_16;
mod q31_32;
pub mod trig;
pub mod vec;

pub use q16_16::Q16_16;
pub use q31_32::Q31_32;
pub use vec::{Vec2, Vec3};

//! Per-app simulation state — the persistent `Model` plus the parameters
//! needed to step it. Lives behind a Mutex on Tauri's managed state so the
//! frontend can advance the sim without re-baking from the wizard.

use std::sync::Mutex;
use std::sync::Arc;
use std::sync::atomic::AtomicU32;
use hayba_tectonics_v2::model::Model;

pub struct SimState {
    pub model: Model,
    pub divisions: u32,
    pub dt_ma: f32,
}

/// Newtype around `Mutex<Option<SimState>>` so the type is unique for
/// `tauri::Manager::manage`. `None` until the first bake completes.
pub struct ManagedSim(pub Mutex<Option<SimState>>);

impl ManagedSim {
    pub fn empty() -> Self {
        ManagedSim(Mutex::new(None))
    }
}

/// Coarse bake phase polled by the frontend so the non-blocking bake
/// can show progress. 0 idle · 1 compute (`bake_impl`) · 2 snapshot
/// (`snapshot_model`) · 3 done.
pub const BAKE_IDLE: u32 = 0;
pub const BAKE_COMPUTE: u32 = 1;
pub const BAKE_SNAPSHOT: u32 = 2;
pub const BAKE_DONE: u32 = 3;

/// `Arc<AtomicU32>` newtype so a `Send + 'static` handle can move into
/// the bake's `spawn_blocking` closure while Tauri keeps the other via
/// `State`. Unique type for `tauri::Manager::manage`.
pub struct BakeProgress(pub Arc<AtomicU32>);

impl BakeProgress {
    pub fn empty() -> Self {
        BakeProgress(Arc::new(AtomicU32::new(BAKE_IDLE)))
    }
}

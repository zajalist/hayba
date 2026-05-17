//! Per-app simulation state — the persistent `Model` plus the parameters
//! needed to step it. Lives behind a Mutex on Tauri's managed state so the
//! frontend can advance the sim without re-baking from the wizard.

use std::sync::Mutex;
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

//! Hayba Explorer — Tauri shell.
//!
//! v0.1 surface: a single `bake_demo_planet` command that returns a hardcoded
//! planet snapshot. Future milestones layer in wizard inputs, time scrubbing,
//! map modes, MCP automation, and live observability UX per the design spec
//! at `docs/superpowers/specs/2026-05-14-hayba-explorer-design.md`.

mod planet;
mod wizard;

#[tauri::command]
fn bake_demo_planet() -> planet::PlanetSnapshot {
    planet::bake_demo()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            bake_demo_planet,
            wizard::start_wizard,
            wizard::roll_seed,
            wizard::bake_from_wizard,
            wizard::compute_partition,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hayba Explorer");
}

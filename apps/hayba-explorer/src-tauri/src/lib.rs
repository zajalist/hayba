//! Hayba Explorer — Tauri shell.

mod planet;
mod wizard;
mod sim_state;
mod climate;
mod hydrology;
mod bake_equirect;
mod scale;

#[tauri::command]
fn bake_demo_planet() -> planet::PlanetSnapshot {
    planet::bake_demo()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(sim_state::ManagedSim::empty())
        .manage(sim_state::BakeProgress::empty())
        .invoke_handler(tauri::generate_handler![
            bake_demo_planet,
            wizard::start_wizard,
            wizard::roll_seed,
            wizard::bake_from_wizard,
            wizard::compute_partition,
            wizard::step_planet,
            wizard::start_tect_sim,
            wizard::tect_step_n,
            wizard::reset_sim,
            wizard::poll_bake_progress,
            wizard::apply_boundary_types,
            wizard::apply_density_rank,
            wizard::get_grid_triangles,
            bake_equirect::bake_inputs_equirect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hayba Explorer");
}

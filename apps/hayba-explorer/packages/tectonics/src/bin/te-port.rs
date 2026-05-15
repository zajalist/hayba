//! `te-port` — wizard-driven CLI front end for the tectonic-v2 sim.
//!
//! Usage:
//!   te-port run <input.json> --output <out.bin> [--steps N]
//!   te-port export <out.bin> --equirect <dir>     (Phase 14 stub)
//!
//! Argument parsing is hand-rolled so we don't pull in `clap` for now.

use std::fs::File;
use std::io::{BufWriter, Read};
use std::path::PathBuf;
use std::process::ExitCode;

use glam::Vec3;
use serde::{Deserialize, Serialize};

use hayba_tectonics_v2::frame_stream::{FrameEncoder, NO_PLATE};
use hayba_tectonics_v2::model::{Model, MAX_PLATE_SPEED};

#[derive(Debug, Deserialize)]
struct WizardInput {
    #[serde(default)]
    wizard_version: String,
    master_seed: u64,
    divisions: u32,
    total_steps: u32,
    dt_ma: f32,
    plates: Vec<WizardPlate>,
}

// ── MINOR 16 — sidecar metadata written next to the .bin output ──────────
#[derive(Debug, Serialize)]
struct SidecarPlate {
    id: u32,
    color: u32,
    density: f32,
}

#[derive(Debug, Serialize)]
struct Sidecar<'a> {
    wizard_version: &'a str,
    master_seed: u64,
    divisions: u32,
    dt_ma: f32,
    total_steps: u32,
    plates: Vec<SidecarPlate>,
}

#[derive(Debug, Deserialize)]
struct WizardPlate {
    id: u32,
    #[serde(default)]
    color: String,
    density: f32,
    #[serde(default)]
    initial_continents: Vec<WizardContinent>,
    #[serde(default)]
    initial_omega: [f32; 3],
}

#[derive(Debug, Deserialize)]
struct WizardContinent {
    /// Center on the unit sphere (will be normalized).
    center: [f32; 3],
    /// Angular radius in radians.
    radius_rad: f32,
}

fn parse_color(hex: &str) -> u32 {
    let s = hex.trim_start_matches('#');
    u32::from_str_radix(s, 16).unwrap_or(0xCCCCCC)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: te-port <run|export> ...");
        return ExitCode::from(2);
    }
    match args[1].as_str() {
        "run" => match cmd_run(&args[2..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("te-port run: {}", e);
                ExitCode::from(1)
            }
        },
        "export" => {
            eprintln!("te-port export: not yet implemented (Phase 14 stub)");
            ExitCode::from(1)
        }
        other => {
            eprintln!("te-port: unknown subcommand {:?}", other);
            ExitCode::from(2)
        }
    }
}

fn cmd_run(args: &[String]) -> Result<(), String> {
    if args.is_empty() {
        return Err("missing <input.json>".into());
    }
    let input_path = PathBuf::from(&args[0]);
    let mut output_path: Option<PathBuf> = None;
    let mut steps_override: Option<u32> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--output" | "-o" => {
                i += 1;
                if i >= args.len() {
                    return Err("--output expects a path".into());
                }
                output_path = Some(PathBuf::from(&args[i]));
            }
            "--steps" => {
                i += 1;
                if i >= args.len() {
                    return Err("--steps expects an integer".into());
                }
                steps_override = Some(args[i].parse().map_err(|e| format!("--steps: {}", e))?);
            }
            other => return Err(format!("unknown arg: {}", other)),
        }
        i += 1;
    }
    let output_path = output_path.ok_or("missing --output <path>")?;

    let mut buf = String::new();
    File::open(&input_path)
        .map_err(|e| format!("opening {:?}: {}", input_path, e))?
        .read_to_string(&mut buf)
        .map_err(|e| format!("reading {:?}: {}", input_path, e))?;
    let input: WizardInput =
        serde_json::from_str(&buf).map_err(|e| format!("parsing wizard JSON: {}", e))?;

    // ── MINOR 10 — wizard input validation ──────────────────────────
    if input.divisions < 1 {
        return Err(format!("divisions must be >= 1 (got {})", input.divisions));
    }
    if !(input.dt_ma > 0.0) {
        return Err(format!("dt_ma must be > 0 (got {})", input.dt_ma));
    }
    if input.plates.len() > NO_PLATE as usize {
        return Err(format!(
            "plates.len() = {} exceeds u16 encoder limit ({})",
            input.plates.len(),
            NO_PLATE
        ));
    }
    {
        let mut ids: Vec<u32> = input.plates.iter().map(|p| p.id).collect();
        ids.sort_unstable();
        for w in ids.windows(2) {
            if w[0] == w[1] {
                return Err(format!("duplicate plate id: {}", w[0]));
            }
        }
    }

    // Build the world.
    let mut model = Model::new(input.divisions, input.master_seed);

    // For each plate, find the nearest fields to its continent centers and
    // assign them. Plates with no continents get a default oceanic seed
    // (a small ring around the equator at id ranges to avoid overlap).
    for wp in &input.plates {
        let mut assigned: Vec<u32> = Vec::new();
        for cont in &wp.initial_continents {
            let c = Vec3::from(cont.center).normalize_or_zero();
            if c == Vec3::ZERO {
                continue;
            }
            // Collect all fields whose dot-product with c >= cos(radius_rad).
            let cos_r = cont.radius_rad.cos();
            for fid in 0..model.grid.n_fields() {
                let p = model.grid.position(fid);
                if p.dot(c) >= cos_r {
                    assigned.push(fid);
                }
            }
        }
        // Deduplicate (a field might fall inside two continent blobs of the
        // same plate) and pick a deterministic order.
        assigned.sort_unstable();
        assigned.dedup();
        // Filter out fields already claimed by an earlier plate — first
        // come, first served in plate-id order.
        assigned.retain(|fid| model.fields[*fid as usize].plate_id.is_none());

        let continental = !wp.initial_continents.is_empty();
        // ── MINOR 11 — clamp |omega| to MAX_PLATE_SPEED on wizard parse.
        let mut omega = Vec3::from(wp.initial_omega);
        let len = omega.length();
        if len > MAX_PLATE_SPEED {
            omega *= MAX_PLATE_SPEED / len;
        }
        let color = parse_color(&wp.color);
        model.add_plate(wp.id, color, wp.density, &assigned, continental, omega);
    }

    // Choose step count.
    let total_steps = steps_override.unwrap_or(input.total_steps);

    // Set up the frame encoder.
    let f = File::create(&output_path)
        .map_err(|e| format!("creating {:?}: {}", output_path, e))?;
    let writer = BufWriter::new(f);
    let mut encoder = FrameEncoder::new(
        writer,
        model.grid.n_fields(),
        input.dt_ma,
        total_steps,
        /* keyframe_stride */ 50,
        input.master_seed,
        &model.fields,
    )
    .map_err(|e| format!("writing header: {}", e))?;

    // Step loop.
    for _ in 0..total_steps {
        model.step(input.dt_ma);
        encoder
            .write_frame(&model.fields)
            .map_err(|e| format!("writing frame: {}", e))?;
    }
    let frame_count = encoder.frames_written();
    let _ = encoder.finish().map_err(|e| format!("flushing: {}", e))?;

    let bytes = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    // ── MINOR 16 — sidecar JSON `<output>.bin.json` (wizard metadata) ───
    let sidecar = Sidecar {
        wizard_version: &input.wizard_version,
        master_seed: input.master_seed,
        divisions: input.divisions,
        dt_ma: input.dt_ma,
        total_steps,
        plates: input
            .plates
            .iter()
            .map(|p| SidecarPlate {
                id: p.id,
                color: parse_color(&p.color),
                density: p.density,
            })
            .collect(),
    };
    let mut sidecar_path = output_path.clone();
    let stem_name = output_path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "out.bin".into());
    sidecar_path.set_file_name(format!("{}.json", stem_name));
    let sidecar_json = serde_json::to_string_pretty(&sidecar)
        .map_err(|e| format!("serialising sidecar: {}", e))?;
    std::fs::write(&sidecar_path, sidecar_json)
        .map_err(|e| format!("writing sidecar {:?}: {}", sidecar_path, e))?;

    eprintln!(
        "te-port run: wrote {} bytes ({} frames) to {:?} (+ sidecar {:?})",
        bytes, frame_count, output_path, sidecar_path
    );
    Ok(())
}

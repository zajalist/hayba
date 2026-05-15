//! End-to-end integration test for the `te-port` CLI.

use std::path::PathBuf;
use std::process::Command;

fn cargo_bin() -> PathBuf {
    // CARGO_BIN_EXE_<name> is set by Cargo when running integration tests.
    let p = env!("CARGO_BIN_EXE_te-port");
    PathBuf::from(p)
}

#[test]
fn cli_run_produces_nonempty_output() {
    let bin = cargo_bin();
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/simple.json");

    // Pick an output path inside Cargo's target dir so it gets cleaned.
    let out = std::env::temp_dir().join("hayba_te_port_cli_test.bin");
    let _ = std::fs::remove_file(&out);

    let status = Command::new(&bin)
        .arg("run")
        .arg(&fixture)
        .arg("--output")
        .arg(&out)
        .arg("--steps")
        .arg("3")
        .status()
        .expect("failed to spawn te-port");
    assert!(status.success(), "te-port exited non-zero");

    let meta = std::fs::metadata(&out).expect("output file should exist");
    assert!(meta.len() > 0, "output should be non-empty");

    // Magic header sanity-check.
    let bytes = std::fs::read(&out).unwrap();
    assert_eq!(&bytes[0..5], b"HAYV2");
    let _ = std::fs::remove_file(&out);
}

/// MAJOR 9 — running `te-port run` twice with identical inputs must yield
/// byte-identical `.bin` output.
#[test]
fn cli_run_is_byte_deterministic_across_runs() {
    let bin = cargo_bin();
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/simple.json");

    let out_a = std::env::temp_dir().join("hayba_te_port_determinism_a.bin");
    let out_b = std::env::temp_dir().join("hayba_te_port_determinism_b.bin");
    for p in [&out_a, &out_b] {
        let _ = std::fs::remove_file(p);
        let mut side = p.clone();
        side.set_file_name(format!(
            "{}.json",
            p.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_file(side);
    }

    for out in [&out_a, &out_b] {
        let status = Command::new(&bin)
            .arg("run")
            .arg(&fixture)
            .arg("--output")
            .arg(out)
            .arg("--steps")
            .arg("8")
            .status()
            .expect("failed to spawn te-port");
        assert!(status.success(), "te-port exited non-zero for {:?}", out);
    }

    let a = std::fs::read(&out_a).expect("read run-a output");
    let b = std::fs::read(&out_b).expect("read run-b output");
    assert_eq!(
        a.len(),
        b.len(),
        "deterministic runs differ in length: {} vs {}",
        a.len(),
        b.len()
    );
    assert_eq!(
        a, b,
        "deterministic runs produced different bytes (len {} == {})",
        a.len(),
        b.len()
    );

    let _ = std::fs::remove_file(&out_a);
    let _ = std::fs::remove_file(&out_b);
}

#[test]
fn cli_export_returns_unimplemented() {
    let bin = cargo_bin();
    let status = Command::new(&bin)
        .arg("export")
        .arg("dummy.bin")
        .arg("--equirect")
        .arg(".")
        .status()
        .expect("failed to spawn te-port");
    // Exits with 1 per the stub.
    assert!(!status.success());
}

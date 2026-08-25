# Render/RHI crash-resilience boundary — 2026-08-10

Issue #387 owns the render-target/readback boundary shared by `render_camera`,
`ui_render_widget_to_png`, and `editor_capture_viewport`.

## Evidence and attribution

The bounded crash corpus contains two distinct `HCR-RHI-001` signatures. One is
a Slate/D3D12 access violation during render-thread work. The other is a D3D12
viewport-resize `E_INVALIDARG` for a 1920x1056 swap chain. Those facts justify a
strict render/shutdown boundary, but they do **not** prove that an MCP render
command alone caused either incident. NullRHI cannot provide positive or
negative evidence about this class.

Source review found five reachable hazards:

1. `render_camera` cast caller dimensions to `int32` without finite, integral,
   dimension, or pixel-budget checks.
2. the UMG path clamped each side to 8192, permitting a 67-million-pixel target
   and at least 256 MiB for one RGBA readback before encoder/RHI scratch;
3. the three entry points had no shared single-flight or shutdown lifecycle;
4. scene capture targets remained attached after a response, extending RHI
   resource lifetime into later work and editor teardown; and
5. the advertised EXR path encoded PNG and then rejected its own output as not
   EXR. It could never produce a verified EXR artifact.

## Boundary

`HaybaMCPRenderSafety` now provides one process-wide render lease and an explicit
monotonic lifecycle:

`acquired -> waiting_for_idle -> allocating_target -> capturing -> reading_back -> encoding -> publishing -> complete`

The lease refuses overlap, NullRHI/commandlet processes, a missing RHI, and any
new operation after shutdown is observed. Total deadlines are finite and capped
at 75 seconds. Render targets are dimension-capped at 4096 per side and
8,388,608 total pixels; inline viewport capture is capped at 1920x1080. Encoded
artifacts are capped at 64 MiB. Non-finite/fractional dimensions and scale are
rejected rather than clamped or narrowed.

Every transient render target is detached, released, and flushed before its
lease drains. Camera component target/FOV/capture flags are restored. PNG/JPEG
bytes are checked for type and encoded dimensions, written to a unique
same-directory temporary file, read back, atomically moved into place, then
read and verified again. Success includes `artifact_verified:true`. EXR is no
longer advertised until a real EXR encoder/verification path exists.

The filesystem boundary is deliberately narrower than the old API: a caller
may supply only a clean filename, never a path. Artifacts are confined to
`Saved/Screenshots/Hayba`, temporary creation is exclusive, and publication is
no-clobber. This removes the former ability to overwrite any accessible
`.png`/`.jpg` and then delete it when final verification failed. Module shutdown
quiesces the render gate before TCP teardown, so a late request cannot begin a
new allocation while the module is unloading.

## Evidence ladder

- Source contract: `render-rhi-safety-contract.test.ts`.
- Pure native policy: `Hayba.MCP.RenderSafety.Policy`.
- Existing real render regression: `Hayba.MCP.UI.RenderWidgetToPng`.

The issue remains open until a disposable editor with a real RHI passes camera,
UMG, and viewport captures; hostile dimension/path/overlap calls leave the
process responsive; the artifacts decode at the requested dimensions; and a
graceful shutdown after the renders creates no new crash signature or prolonged
`~FD3D12DynamicRHI` stall. That test must record crash-directory count before
and after. A NullRHI run is useful only for proving clean refusal.

# Tasks

## Active

- [ ] **Built-in Hayba agent profiling and UE performance tooling** - give the in-editor agents a measured inspect → diagnose → propose → verify workflow backed by [the September 23 handoff](docs/handoffs/2026-09-23-ue-perf-tooling.md), in small reviewed slices against UE 5.8.2.
  - Agent experience: make profiling discoverable in chat, let an agent gather a bounded baseline, cite actual measurements and tool evidence, explain uncertainty, request approval before changes, then rerun the same measurements to verify impact. Keep read-only diagnostics distinct from mutations.
  - Start with a focused performance agent/tool path, not another sprawling mode or dashboard. Cover framerate/frame time, CPU/GPU bottleneck, VRAM/texture streaming, Nanite, PCG/instancing, World Partition, and crash evidence where the engine exposes reliable data.
  - First: `cvar_query` and readback-verified `cvar_set`; `console_exec` with captured output; structured PCG spawner audit before descriptor mutation.
  - Next: crash-report reader, texture/GPU memory reports, and native World Partition region load/unload with a dry run and no Python `Guid` construction.
  - Then: Nanite asset audit, post-import asset existence reliability, material-tool argument fixes, and clearer `python_run` limits/errors.
  - Safety: never recommend disabling deformable-shadow invalidation globally or relying on `foliage.MaxEndCullDistance` for plain PCG ISM/Nanite; distinguish configured memory ceilings from actual use.

## Waiting On

## Someday

## Done

//
// Maps executor.kind strings to executor functions. Each category
// (composition, lighting, pcg_diff, …) registers one entry per concrete
// sliver. Slivers loaded from disk look up their executor here at run
// time; a missing kind is a clear "executor not bundled" error.

import type { SliverExecutor } from './types.js';

export class ExecutorRegistry {
  private readonly byKind = new Map<string, SliverExecutor>();

  register(kind: string, executor: SliverExecutor): void {
    if (this.byKind.has(kind)) {
      throw new Error(`Executor kind "${kind}" already registered`);
    }
    this.byKind.set(kind, executor);
  }

  get(kind: string): SliverExecutor | undefined {
    return this.byKind.get(kind);
  }

  kinds(): string[] {
    return [...this.byKind.keys()];
  }
}

/** Approvals the LOCAL user granted; the brain cannot mint these. They live for one turn only. */
export class LocalApprovals {
  private granted = new Set<string>();
  add(call: { name: string; argsHash: string }): void { this.granted.add(`${call.name}\u0000${call.argsHash}`); }
  consume(name: string, hash: string): boolean { return this.granted.delete(`${name}\u0000${hash}`); }
  /** The turn reached `done`: anything it didn't use must not carry over to a later turn. */
  clear(): void { this.granted.clear(); }
}

/** Approvals the LOCAL user granted; the brain cannot mint these. */
export class LocalApprovals {
  private granted = new Set<string>();
  add(call: { name: string; argsHash: string }): void { this.granted.add(`${call.name}\u0000${call.argsHash}`); }
  consume(name: string, hash: string): boolean { return this.granted.delete(`${name}\u0000${hash}`); }
}

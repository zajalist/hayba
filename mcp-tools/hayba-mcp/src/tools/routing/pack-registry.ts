export type PackKind = 'domain' | 'workflow';
export type AutoLoadTrigger = 'ue_connected';

export interface PackDef {
  name: string;
  kind: PackKind;
  description: string;
  tools: string[];
  autoLoadOn?: AutoLoadTrigger;
}

export interface PackListEntry extends PackDef {
  loaded: boolean;
  toolCount: number;
}

export type LoadResult =
  | { ok: true; addedTools: string[] }
  | { ok: false; reason: 'unknown_pack'; available: string[] };

export type OnPacksChanged = () => void | Promise<void>;

export class PackRegistry {
  private packs = new Map<string, PackDef>();
  private loaded = new Set<string>();
  private locks = new Map<string, Promise<void>>();

  constructor(packs: PackDef[], private onChange: OnPacksChanged) {
    for (const p of packs) this.packs.set(p.name, p);
  }

  listPacks(): PackListEntry[] {
    return Array.from(this.packs.values()).map(p => ({
      ...p,
      loaded: this.loaded.has(p.name),
      toolCount: p.tools.length,
    }));
  }

  isLoaded(name: string): boolean { return this.loaded.has(name); }

  loadedTools(): string[] {
    const set = new Set<string>();
    for (const name of this.loaded) {
      for (const t of this.packs.get(name)?.tools ?? []) set.add(t);
    }
    return Array.from(set);
  }

  async loadPack(name: string): Promise<LoadResult> {
    const p = this.packs.get(name);
    if (!p) return { ok: false, reason: 'unknown_pack', available: Array.from(this.packs.keys()) };

    const existing = this.locks.get(name);
    if (existing) { await existing; }
    if (this.loaded.has(name)) return { ok: true, addedTools: [] };

    const before = new Set(this.loadedTools());
    let release!: () => void;
    const lock = new Promise<void>(res => { release = res; });
    this.locks.set(name, lock);
    try {
      this.loaded.add(name);
      const added = p.tools.filter(t => !before.has(t));
      await this.onChange();
      return { ok: true, addedTools: added };
    } finally {
      this.locks.delete(name);
      release();
    }
  }

  async unloadPack(name: string): Promise<void> {
    if (!this.loaded.delete(name)) return;
    await this.onChange();
  }

  async maybeAutoLoad(trigger: AutoLoadTrigger): Promise<void> {
    for (const p of this.packs.values()) {
      if (p.autoLoadOn === trigger && !this.loaded.has(p.name)) {
        await this.loadPack(p.name);
      }
    }
  }
}

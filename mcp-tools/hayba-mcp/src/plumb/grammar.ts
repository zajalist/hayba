import type { Symbol, Production, EmitOp } from './contracts.js';

export interface PlacedItem {
  kind: EmitOp['emit'];
  role?: string;
  tag?: string;
  symbolKind: string;
  index: number;
  meta: Record<string, unknown>;
}

export interface PlacementPlan {
  items: PlacedItem[];
  weaknesses: string[];
  rejected: string[];
}

export type GuardFn = (
  guardIds: string[],
  ops: EmitOp[],
  sym: Symbol,
) => { hardFail: boolean; softFails: string[] };

function whenMatches(sym: Symbol, when?: Record<string, unknown>): boolean {
  if (!when) return true;
  for (const [k, v] of Object.entries(when)) {
    if (k.endsWith('_gt')) {
      const key = k.slice(0, -3);
      if (!((sym.attrs[key] as number) > (v as number))) return false;
    } else if ((sym.attrs as any)[k] !== v) return false;
  }
  return true;
}

export function matchProductions(sym: Symbol, prods: Production[]): Production[] {
  return prods
    .filter(p => p.lhs.kind === sym.kind && whenMatches(sym, p.lhs.when))
    .sort((a, b) => b.priority - a.priority);
}

const MAX_DEPTH = 6;
const MAX_ITEMS = 512;

export function expandGrammar(
  seed: Symbol,
  prods: Production[],
  guards: GuardFn,
): PlacementPlan {
  const plan: PlacementPlan = { items: [], weaknesses: [], rejected: [] };
  const queue: Array<{ sym: Symbol; depth: number }> = [{ sym: seed, depth: 0 }];
  let idx = 0;

  while (queue.length && plan.items.length < MAX_ITEMS) {
    const { sym, depth } = queue.shift()!;
    if (depth > MAX_DEPTH) continue;

    let committed = false;
    for (const prod of matchProductions(sym, prods)) {
      const verdict = guards(prod.guards, prod.rhs, sym);
      if (verdict.hardFail) {
        plan.rejected.push(prod.id);
        continue;
      }
      plan.weaknesses.push(...verdict.softFails);
      for (const op of prod.rhs) {
        if (op.emit === 'symbol') {
          queue.push({
            sym: { kind: op.kind, attrs: { ...sym.attrs, len: op.len ?? 0 } },
            depth: depth + 1,
          });
        } else {
          plan.items.push({
            kind: op.emit,
            role: (op as any).role,
            tag: (op as any).tag,
            symbolKind: sym.kind,
            index: idx++,
            meta: { ...op },
          });
        }
      }
      committed = true;
      break;
    }

    if (!committed) plan.rejected.push(`<no-production:${sym.kind}>`);
  }

  return plan;
}

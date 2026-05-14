import { hashPrompt } from './prompt-builder.js';
import type { AIProvider, BindingRequest, RawBindingResponse } from './types.js';

export class MockProvider implements AIProvider {
  readonly name = 'mock' as const;
  readonly model = 'mock-deterministic';

  async generate(req: BindingRequest, prompt: { system: string; user: string }): Promise<RawBindingResponse> {
    const profiles: Record<string, string> = {};
    for (const slot of req.element.profileSlots) {
      profiles[slot.name] = _profileFor(slot, req.seed ?? 0n);
    }
    const params: Record<string, number | string> = {};
    for (const slot of req.element.paramSchema) {
      params[slot.name] = _paramFor(slot);
    }
    const rationale = `Mock provider output for ${req.element.id} × ${req.styleSheet.id} (seed=${(req.seed ?? 0n).toString(16)}).`;
    const rawText = JSON.stringify({ profiles, params, rationale }, null, 2);
    return {
      rawText,
      provider: 'mock',
      model: this.model,
      promptHash: hashPrompt(prompt.system, prompt.user),
    };
  }
}

function _profileFor(slot: { hint: string; bbox?: readonly [number, number, number, number] }, seed: bigint): string {
  const jitter = Number((seed & 0xfn)) * 2;
  const [x, y, w, h] = slot.bbox ?? [0, 0, 100, 100];
  if (slot.hint === 'symmetric-half') {
    return `<svg viewBox="${x} ${y} ${w} ${h}"><path d="M0 ${y} L ${(w / 2) + jitter} ${y} L ${(w / 2) + jitter} ${y + h} L 0 ${y + h} Z"/></svg>`;
  }
  if (slot.hint === 'closed-path') {
    const cx = x + w / 2, cy = y + h / 2;
    const r = Math.min(w, h) * 0.4 - jitter;
    return `<svg viewBox="${x} ${y} ${w} ${h}"><path d="M${cx - r} ${cy - r} L ${cx + r} ${cy - r} L ${cx + r} ${cy + r} L ${cx - r} ${cy + r} Z"/></svg>`;
  }
  return `<svg viewBox="${x} ${y} ${w} ${h}"><path d="M${x} ${y} L ${x + w} ${y + h}"/></svg>`;
}

function _paramFor(slot: { kind: string; range?: readonly [number, number]; choices?: readonly string[]; default: number | string }): number | string {
  if (slot.kind === 'enum') return slot.default;
  if (!slot.range) return slot.default;
  const mid = (slot.range[0] + slot.range[1]) / 2;
  return slot.kind === 'integer' ? Math.round(mid) : mid;
}

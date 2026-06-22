import { describe, it, expect } from 'vitest';
import { formatOptimizationFeedback, maxInstructions, type MaterialStats } from './material-stats.js';

describe('material-stats: maxInstructions', () => {
  it('returns the peak across shader permutations', () => {
    const stats: MaterialStats = {
      shaders: [
        { name: 'Base pass shader', instructions: 142 },
        { name: 'Base pass shader with CSM', instructions: 188 },
      ],
    };
    expect(maxInstructions(stats)).toBe(188);
  });

  it('returns 0 when no shaders', () => {
    expect(maxInstructions({})).toBe(0);
  });
});

describe('material-stats: formatOptimizationFeedback', () => {
  it('returns null when stats are absent', () => {
    expect(formatOptimizationFeedback(undefined)).toBeNull();
    expect(formatOptimizationFeedback(null)).toBeNull();
    expect(formatOptimizationFeedback({})).toBeNull();
  });

  it('renders instruction counts and a peak', () => {
    const out = formatOptimizationFeedback({
      shaders: [
        { name: 'Base pass shader', instructions: 142 },
        { name: 'Base pass shader with CSM', instructions: 156 },
      ],
      texture_samples: 4,
      samplers: 3,
      max_samplers: 16,
      interpolators_used: 8,
      interpolators_max: 16,
    });
    expect(out).toContain('OPTIMIZATION FEEDBACK');
    expect(out).toContain('peak: 156');
    expect(out).toContain('Base pass shader: 142');
    expect(out).toContain('Texture samples: 4');
    expect(out).toContain('Samplers: 3/16');
    expect(out).toContain('Interpolator scalars: 8/16');
  });

  it('emits a high-instruction hint past the high threshold', () => {
    const out = formatOptimizationFeedback({
      shaders: [{ name: 'Base pass shader', instructions: 400 }],
    });
    expect(out).toContain('Hints:');
    expect(out).toMatch(/instruction count is high/i);
  });

  it('emits a warning hint in the warn band but not the high hint', () => {
    const out = formatOptimizationFeedback({
      shaders: [{ name: 'Base pass shader', instructions: 250 }],
    });
    expect(out).toMatch(/getting heavy/i);
    expect(out).not.toMatch(/instruction count is high/i);
  });

  it('warns on heavy texture sampling', () => {
    const out = formatOptimizationFeedback({
      shaders: [{ name: 'Base pass shader', instructions: 50 }],
      texture_samples: 12,
    });
    expect(out).toMatch(/texture samples/i);
    expect(out).toMatch(/packing channels/i);
  });

  it('warns when the sampler budget is reached', () => {
    const out = formatOptimizationFeedback({
      shaders: [{ name: 'Base pass shader', instructions: 50 }],
      samplers: 16,
      max_samplers: 16,
    });
    expect(out).toMatch(/Sampler budget reached/i);
  });

  it('shows dependent-lookup detail when texture_lookups differs', () => {
    const out = formatOptimizationFeedback({
      texture_samples: 4,
      texture_lookups: 6,
    });
    expect(out).toContain('Texture samples: 4 (6 lookups incl. dependent)');
  });

  it('renders even when only numeric stats are present (no shaders array)', () => {
    const out = formatOptimizationFeedback({ samplers: 2, max_samplers: 16 });
    expect(out).toContain('OPTIMIZATION FEEDBACK');
    expect(out).toContain('Samplers: 2/16');
  });
});

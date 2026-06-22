import { describe, expect, it } from 'vitest';
import { computeHabitableZone } from './habitable-zone.js';

describe('computeHabitableZone', () => {
  it('Sun-like star yields HZ distances near published Kopparapu values', () => {
    const hz = computeHabitableZone(1, 5780, 1);
    expect(hz.distanceAu.conservativeInner).toBeGreaterThan(0.93);
    expect(hz.distanceAu.conservativeInner).toBeLessThan(1.02);
    expect(hz.distanceAu.conservativeOuter).toBeGreaterThan(1.6);
    expect(hz.distanceAu.conservativeOuter).toBeLessThan(1.78);
  });

  it('super-Earth moves conservative inner edge inward vs Earth mass', () => {
    const earth = computeHabitableZone(1, 5600, 1);
    const superEarth = computeHabitableZone(1, 5600, 5);
    expect(superEarth.distanceAu.conservativeInner).toBeLessThan(earth.distanceAu.conservativeInner);
  });
});

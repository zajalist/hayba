import { describe, it, expect } from "vitest";
import {
  EQUIRECT_MAP_MODES,
  resolveEquirectMode,
} from "./equirectMapModes";

describe("EQUIRECT_MAP_MODES registry (SP-B)", () => {
  it("is exactly the 6 data-backed modes in order", () => {
    expect(EQUIRECT_MAP_MODES.map((m) => m.label)).toEqual([
      "Relief",
      "Normal",
      "Temperature",
      "Precipitation",
      "Wind",
      "Glaciation",
    ]);
  });
  it("kinds: relief, normal, then 4 clim", () => {
    expect(EQUIRECT_MAP_MODES.map((m) => m.kind)).toEqual([
      "relief",
      "normal",
      "clim",
      "clim",
      "clim",
      "clim",
    ]);
  });
});

describe("resolveEquirectMode (SP-B)", () => {
  it("Relief → uStackMode 0, no tex", () => {
    expect(resolveEquirectMode(0, true)).toEqual({
      kind: "relief",
      channel: 0,
      ramp: 0,
      mode: 0,
    });
  });
  it("Normal → uStackMode 3, no tex, ignores draped", () => {
    expect(resolveEquirectMode(1, true)).toEqual({
      kind: "normal",
      channel: 0,
      ramp: 0,
      mode: 3,
    });
    expect(resolveEquirectMode(1, false).mode).toBe(3);
  });
  it("Temperature → clim ch0 ramp1, draped→mode1 / flat→mode2", () => {
    expect(resolveEquirectMode(2, true)).toEqual({
      kind: "clim",
      channel: 0,
      ramp: 1,
      mode: 1,
    });
    expect(resolveEquirectMode(2, false).mode).toBe(2);
  });
  it("Precipitation/Wind/Glaciation channels+ramps", () => {
    expect(resolveEquirectMode(3, true)).toMatchObject({ channel: 1, ramp: 2 });
    expect(resolveEquirectMode(4, true)).toMatchObject({ channel: 2, ramp: 3 });
    expect(resolveEquirectMode(5, true)).toMatchObject({ channel: 3, ramp: 4 });
  });
  it("out-of-range idx falls back to Relief", () => {
    expect(resolveEquirectMode(99, true).kind).toBe("relief");
  });
});

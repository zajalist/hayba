import { describe, it, expect } from "vitest";
import {
  EQUIRECT_MAP_MODES,
  resolveEquirectMode,
} from "./equirectMapModes";

describe("EQUIRECT_MAP_MODES registry (SP-B + COOKBOOK-CLIMATE T3)", () => {
  it("is exactly the 9 data-backed modes in order", () => {
    expect(EQUIRECT_MAP_MODES.map((m) => m.label)).toEqual([
      "Relief",
      "Normal",
      "Temperature",
      "Precipitation",
      "Wind",
      "Glaciation",
      "Distance",
      "Continentality",
      "Pressure",
    ]);
  });
  it("kinds (SP-B + cookbook-T3 dist/pressure)", () => {
    expect(EQUIRECT_MAP_MODES.map((m) => m.kind)).toEqual([
      "relief",
      "normal",
      "clim",
      "clim",
      "wind",
      "clim",
      "dist",
      "dist",
      "pressure",
    ]);
  });
});

describe("COOKBOOK-CLIMATE T3 — Distance/Continentality/Pressure modes", () => {
  it("Distance resolves to dist ch0 (distKm), uStackMode 1 draped / 2 flat", () => {
    const idx = EQUIRECT_MAP_MODES.findIndex((m) => m.label === "Distance");
    expect(idx).toBe(6);
    expect(resolveEquirectMode(idx, true)).toEqual({
      kind: "dist",
      channel: 0,
      ramp: 0,
      mode: 1,
    });
    expect(resolveEquirectMode(idx, false).mode).toBe(2);
  });
  it("Continentality resolves to dist ch1 (cont 0..1) with Köppen-D ramp 5", () => {
    const idx = EQUIRECT_MAP_MODES.findIndex((m) => m.label === "Continentality");
    expect(idx).toBe(7);
    expect(resolveEquirectMode(idx, true)).toMatchObject({
      kind: "dist",
      channel: 1,
      ramp: 5,
    });
  });
  it("Pressure resolves to pressure ch0 with diverging ramp 6", () => {
    const idx = EQUIRECT_MAP_MODES.findIndex((m) => m.label === "Pressure");
    expect(idx).toBe(8);
    expect(resolveEquirectMode(idx, true)).toMatchObject({
      kind: "pressure",
      channel: 0,
      ramp: 6,
    });
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

describe("NX-3 Wind animated mode", () => {
  it("Wind resolves to animated uStackMode 4 (draped) / 5 (flat)", () => {
    const windIdx = EQUIRECT_MAP_MODES.findIndex((m) => m.label === "Wind");
    expect(windIdx).toBe(4);
    expect(EQUIRECT_MAP_MODES[windIdx].kind).toBe("wind");
    expect(resolveEquirectMode(windIdx, true)).toEqual({ kind: "wind", channel: 2, ramp: 3, mode: 4 });
    expect(resolveEquirectMode(windIdx, false)).toEqual({ kind: "wind", channel: 2, ramp: 3, mode: 5 });
  });
  it("other modes' resolution byte-unchanged (regression pin)", () => {
    expect(resolveEquirectMode(0, true)).toEqual({ kind: "relief", channel: 0, ramp: 0, mode: 0 });
    expect(resolveEquirectMode(1, true)).toEqual({ kind: "normal", channel: 0, ramp: 0, mode: 3 });
    expect(resolveEquirectMode(2, true)).toEqual({ kind: "clim", channel: 0, ramp: 1, mode: 1 });
    expect(resolveEquirectMode(3, false)).toEqual({ kind: "clim", channel: 1, ramp: 2, mode: 2 });
    expect(resolveEquirectMode(5, true)).toEqual({ kind: "clim", channel: 3, ramp: 4, mode: 1 });
  });
});

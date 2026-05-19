import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  fidelityToTier,
  tierToFidelity,
  loadFidelity,
  saveFidelity,
  DEFAULT_FIDELITY,
  type Fidelity,
} from "./fidelity";

class MemStore {
  private m = new Map<string, string>();
  throwOnGet = false;
  throwOnSet = false;
  getItem(k: string): string | null {
    if (this.throwOnGet) throw new Error("blocked");
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    if (this.throwOnSet) throw new Error("quota");
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

let store: MemStore;
const realLS = (globalThis as { localStorage?: Storage }).localStorage;

beforeEach(() => {
  store = new MemStore();
  Object.defineProperty(globalThis, "localStorage", {
    value: store,
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: realLS,
    configurable: true,
  });
});

describe("fidelity preset (SETTINGS-1)", () => {
  it("fidelityToTier maps low/medium/high to 0/1/2", () => {
    expect(fidelityToTier("low")).toBe(0);
    expect(fidelityToTier("medium")).toBe(1);
    expect(fidelityToTier("high")).toBe(2);
    expect(fidelityToTier("bogus" as Fidelity)).toBe(0);
  });
  it("tierToFidelity is the inverse, out-of-range -> low", () => {
    expect(tierToFidelity(0)).toBe("low");
    expect(tierToFidelity(1)).toBe("medium");
    expect(tierToFidelity(2)).toBe("high");
    expect(tierToFidelity(99)).toBe("low");
    expect(tierToFidelity(-1)).toBe("low");
  });
  it("loadFidelity returns DEFAULT when empty / garbage / throwing", () => {
    expect(loadFidelity()).toBe(DEFAULT_FIDELITY);
    store.setItem("hayba.fidelity", "xyz");
    expect(loadFidelity()).toBe(DEFAULT_FIDELITY);
    store.setItem("hayba.fidelity", "high");
    store.throwOnGet = true;
    expect(loadFidelity()).toBe(DEFAULT_FIDELITY);
  });
  it("saveFidelity round-trips all three", () => {
    for (const f of ["low", "medium", "high"] as Fidelity[]) {
      saveFidelity(f);
      expect(loadFidelity()).toBe(f);
    }
  });
  it("saveFidelity swallows a throwing setItem", () => {
    store.throwOnSet = true;
    expect(() => saveFidelity("high")).not.toThrow();
  });
});

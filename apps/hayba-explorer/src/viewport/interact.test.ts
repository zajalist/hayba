import { describe, it, expect } from "vitest";
import { nextInteract, type InteractState } from "./interact";

describe("nextInteract (SP-A interaction state machine)", () => {
  it("Bake moves compose -> explore", () => {
    expect(nextInteract("compose", "bake")).toBe<InteractState>("explore");
  });
  it("Bake from explore stays explore (re-bake)", () => {
    expect(nextInteract("explore", "bake")).toBe<InteractState>("explore");
  });
  it("Edit moves explore -> compose (the only path back)", () => {
    expect(nextInteract("explore", "edit")).toBe<InteractState>("compose");
  });
  it("Edit from compose stays compose", () => {
    expect(nextInteract("compose", "edit")).toBe<InteractState>("compose");
  });
});

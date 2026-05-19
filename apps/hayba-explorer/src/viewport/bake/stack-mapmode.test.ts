import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const hydraulicSrc = readFileSync(
  fileURLToPath(new URL("./hydraulic.ts", import.meta.url)),
  "utf8",
);

describe("runHydraulicBake return-shape (Task 1)", () => {
  it("declares the 5-RT HydraulicBakeResult and returns it", () => {
    expect(hydraulicSrc).toContain("export interface HydraulicBakeResult");
    expect(hydraulicSrc).toMatch(
      /return\s*\{\s*eroded:\s*result,\s*clim:\s*CLIM\[0\],\s*terr:\s*TERR\[0\],\s*hydro:\s*HYDRO\[0\],\s*wind:\s*WIND\[0\]\s*\}/,
    );
    expect(hydraulicSrc).toContain(
      "): Promise<HydraulicBakeResult> {",
    );
  });

  it("teardown disposes the transient [1] slots but NOT the returned [0] stack slots", () => {
    expect(hydraulicSrc).toContain("CLIM[1].dispose();");
    expect(hydraulicSrc).toContain("TERR[1].dispose();");
    expect(hydraulicSrc).toContain("HYDRO[1].dispose();");
    expect(hydraulicSrc).not.toContain("CLIM[0].dispose();");
    expect(hydraulicSrc).not.toContain("TERR[0].dispose();");
    expect(hydraulicSrc).not.toContain("HYDRO[0].dispose();");
  });
});

import { makeDebugReliefMaterial, setDebugStack } from "./debugMaterial";

describe("debugMaterial generalized stack uniforms (Task 2)", () => {
  it("exposes stack uniforms with relief-safe defaults", () => {
    const m = makeDebugReliefMaterial();
    expect(m.uniforms.uStackTex).toBeDefined();
    expect(m.uniforms.uChannel.value).toBe(0);
    expect(m.uniforms.uStackMode.value).toBe(0); // 0 = relief (today)
    expect(m.uniforms.uRamp.value).toBe(0);
    expect(m.uniforms.uStackTex.value).not.toBeNull(); // placeholder, never null
  });

  it("relief shader path is regression-pinned (verbatim expressions present)", () => {
    const m = makeDebugReliefMaterial();
    const f = m.fragmentShader;
    expect(f).toContain("float h = mix(hEroded, hRaw, step(0.5, uMapMode));");
    expect(f).toContain("vec3 base = hypsometric(h);");
    expect(f).toContain("vec3 col = base * shade;");
    expect(f).toContain("col = mix(col, col * 0.62, steep * 0.5);");
    expect(f).toContain("if (h < 0.0) col += vec3(0.02, 0.03, 0.05) * (1.0 + h);");
    expect(f).toContain("if (uStackMode < 0.5){");
  });

  it("setDebugStack writes all four stack uniforms", () => {
    const m = makeDebugReliefMaterial();
    setDebugStack(m, { tex: null, channel: 2, mode: 1, ramp: 3 });
    expect(m.uniforms.uChannel.value).toBe(2);
    expect(m.uniforms.uStackMode.value).toBe(1);
    expect(m.uniforms.uRamp.value).toBe(3);
    expect(m.uniforms.uStackTex.value).not.toBeNull(); // null -> placeholder
  });
});

describe("debugMaterial Normal map mode (SP-B, uStackMode 3)", () => {
  it("FRAG has an additive uStackMode>2.5 Normal branch emitting sn*0.5+0.5", () => {
    const m = makeDebugReliefMaterial();
    const f = m.fragmentShader;
    expect(f).toContain("if (uStackMode > 2.5){");
    expect(f).toContain("gl_FragColor = vec4(sn * 0.5 + 0.5, 1.0);");
  });
  it("relief gate + stack ramp paths are still byte-present (regression pin)", () => {
    const f = makeDebugReliefMaterial().fragmentShader;
    expect(f).toContain("if (uStackMode < 0.5){");
    expect(f).toContain("vec3 rc = ramp(uRamp, chv);");
    expect(f).toContain("if (uStackMode > 1.5){");
  });
  it("VERT skips displacement ONLY for flat (uStackMode 2), not Normal(3)", () => {
    const v = makeDebugReliefMaterial().vertexShader;
    expect(v).toContain(
      "float dispGain = (uStackMode > 1.5 && uStackMode < 2.5) ? 0.0 : 1.0;",
    );
    expect(v).not.toContain("float dispGain = (uStackMode > 1.5) ? 0.0 : 1.0;");
  });
});

describe("NX-3 wind-anim shader branch", () => {
  it("adds uStackMode>3.5 wind branch + uWindTime, 0-3 byte-pinned", () => {
    const f = makeDebugReliefMaterial().fragmentShader;
    expect(f).toContain("uniform float uWindTime;");
    expect(f).toContain("uStackMode > 3.5");
    expect(f).toContain("if (uStackMode < 0.5){");
    expect(f).toContain("if (uStackMode > 2.5){");
    expect(f).toContain("gl_FragColor = vec4(sn * 0.5 + 0.5, 1.0);");
  });
});

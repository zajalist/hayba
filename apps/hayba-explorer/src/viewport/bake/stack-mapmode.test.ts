import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const hydraulicSrc = readFileSync(
  fileURLToPath(new URL("./hydraulic.ts", import.meta.url)),
  "utf8",
);

describe("runHydraulicBake return-shape (Task 1)", () => {
  it("declares the 4-RT HydraulicBakeResult and returns it", () => {
    expect(hydraulicSrc).toContain("export interface HydraulicBakeResult");
    expect(hydraulicSrc).toMatch(
      /return\s*\{\s*eroded:\s*result,\s*clim:\s*CLIM\[0\],\s*terr:\s*TERR\[0\],\s*hydro:\s*HYDRO\[0\]\s*\}/,
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

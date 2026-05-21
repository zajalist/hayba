// Regression guard for PR #203: shadowing a GLSL builtin function name
// with a local variable can silently fail-to-link the relief shader on
// some drivers (ANGLE / SwiftShader). The Rivers/Lakes ramp had
//   vec3 tan = vec3(0.85, 0.78, 0.55);
// and `tan` is the GLSL tangent() builtin — the resulting shader-link
// failure made the entire planet sphere invisible after every bake,
// presenting to the user as "bake doesn't work, goes back to the
// non-baked input view".

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const GLSL_BUILTINS = new Set([
  "sin", "cos", "tan", "asin", "acos", "atan",
  "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
  "radians", "degrees",
  "pow", "exp", "log", "exp2", "log2", "sqrt", "inversesqrt",
  "abs", "sign", "floor", "ceil", "round", "roundEven", "trunc", "fract",
  "mod", "modf", "min", "max", "clamp", "mix", "step", "smoothstep",
  "isnan", "isinf", "fma",
  "length", "distance", "dot", "cross", "normalize", "reflect", "refract",
  "transpose", "determinant", "inverse",
  "dFdx", "dFdy", "fwidth",
]);

const DECL =
  /\b(?:float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234])\s+([A-Za-z_]\w*)\s*[=;,)]/g;

function findShadows(src: string): string[] {
  const hits: string[] = [];
  let m: RegExpExecArray | null;
  DECL.lastIndex = 0;
  while ((m = DECL.exec(src)) !== null) {
    if (GLSL_BUILTINS.has(m[1])) hits.push(m[1]);
  }
  return hits;
}

describe("GLSL builtin-shadow regression guard (PR #203)", () => {
  it("debugMaterial.ts FRAG declares no variable named after a GLSL builtin", () => {
    const src = readFileSync(join(HERE, "debugMaterial.ts"), "utf8");
    const hits = findShadows(src);
    expect(hits, `debugMaterial shadows GLSL builtins: ${hits.join(", ")}`).toEqual([]);
  });

  it("hydraulic.glsl.ts declares no variable named after a GLSL builtin", () => {
    const src = readFileSync(join(HERE, "hydraulic.glsl.ts"), "utf8");
    const hits = findShadows(src);
    expect(hits, `hydraulic.glsl shadows GLSL builtins: ${hits.join(", ")}`).toEqual([]);
  });

  it("specifically: `vec3 tan` (the bug that broke baking) is gone", () => {
    const dm = readFileSync(join(HERE, "debugMaterial.ts"), "utf8");
    const hg = readFileSync(join(HERE, "hydraulic.glsl.ts"), "utf8");
    expect(dm).not.toMatch(/\bvec3\s+tan\s*[=;]/);
    expect(hg).not.toMatch(/\bvec3\s+tan\s*[=;]/);
  });
});

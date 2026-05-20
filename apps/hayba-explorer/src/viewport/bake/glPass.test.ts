import { describe, it, expect } from "vitest";
import { __parseUniformTypesForTest } from "./glPass";

describe("glPass parseUniformTypes — runPointPass enablement", () => {
  it("parses uniforms from a vert source using gl_VertexID + sampler2D", () => {
    const src = [
      "uniform sampler2D uPart;",
      "uniform vec2 uPartDim;",
      "uniform sampler2D uWind;",
      "out float v_intensity;",
      "void main(){",
      "  int id = gl_VertexID;",
      "  int w = int(uPartDim.x);",
      "  ivec2 rc = ivec2(id - (id / w) * w, id / w);",
      "  vec4 s = texelFetch(uPart, rc, 0);",
      "  gl_Position = vec4(s.xy * 2.0 - 1.0, 0.0, 1.0);",
      "  gl_PointSize = 2.0;",
      "  v_intensity = texture(uWind, s.xy).z;",
      "}",
    ].join("\n");
    const m = __parseUniformTypesForTest(src);
    expect(m.get("uPart")).toBe("sampler2D");
    expect(m.get("uPartDim")).toBe("vec2");
    expect(m.get("uWind")).toBe("sampler2D");
  });
});

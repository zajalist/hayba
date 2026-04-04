import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { SwarmHostClient } from "../src/swarmhost.js";

const BASE = "http://localhost:7000";

const server = setupServer(
  http.get(`${BASE}/health`, () => HttpResponse.json({ status: "ok" })),
  http.get(`${BASE}/nodes`, () =>
    HttpResponse.json({
      nodes: [
        {
          type: "Mountain",
          category: "primitives",
          parameters: [{ name: "Height", type: "float", min: 0, max: 1, default: 0.5 }],
          inputs: [],
          outputs: ["Primary"]
        }
      ]
    })
  ),
  http.post(`${BASE}/graph`, () => HttpResponse.json({ success: true })),
  http.post(`${BASE}/graph/load`, () => HttpResponse.json({ success: true })),
  http.get(`${BASE}/graph/state`, () =>
    HttpResponse.json({
      nodes: [{ id: "m1", type: "Mountain", params: { Height: 0.5 }, cookStatus: "clean" }],
      edges: []
    })
  ),
  http.get(`${BASE}/graph/nodes/m1/parameters`, () =>
    HttpResponse.json([{ name: "Height", type: "float", min: 0, max: 1, default: 0.5 }])
  ),
  http.put(`${BASE}/graph/nodes/m1/parameters/Height`, () =>
    HttpResponse.json({ success: true })
  ),
  http.post(`${BASE}/graph/cook`, () =>
    HttpResponse.json({ success: true })
  ),
  http.post(`${BASE}/graph/export`, () =>
    HttpResponse.json({ heightmap: "C:\\tmp\\heightmap.exr" })
  )
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

const client = new SwarmHostClient(7000);

describe("SwarmHostClient", () => {
  it("health() returns ok", async () => {
    const res = await client.health();
    expect(res.status).toBe("ok");
  });

  it("listNodeTypes() returns node catalog", async () => {
    const nodes = await client.listNodeTypes();
    expect(nodes[0].type).toBe("Mountain");
    expect(nodes[0].outputs).toContain("Primary");
  });

  it("createGraph() sends graph JSON", async () => {
    await expect(
      client.createGraph({ nodes: [{ id: "m1", type: "Mountain", params: {} }], edges: [] })
    ).resolves.not.toThrow();
  });

  it("loadGraph() sends terrain path", async () => {
    await expect(client.loadGraph("C:\\terrain.terrain")).resolves.not.toThrow();
  });

  it("getGraphState() returns state", async () => {
    const state = await client.getGraphState();
    expect(state.nodes[0].id).toBe("m1");
  });

  it("getParameters() returns param list", async () => {
    const params = await client.getParameters("m1");
    expect(params[0].name).toBe("Height");
  });

  it("setParameter() succeeds", async () => {
    await expect(client.setParameter("m1", "Height", 0.8)).resolves.not.toThrow();
  });

  it("cook() succeeds", async () => {
    await expect(client.cook()).resolves.not.toThrow();
  });

  it("export() returns file paths", async () => {
    const result = await client.export("C:\\tmp", "EXR");
    expect(result.heightmap).toContain("heightmap");
  });
});

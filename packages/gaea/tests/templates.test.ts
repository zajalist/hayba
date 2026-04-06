import { describe, it, expect } from "vitest";
import { getTemplate, listTemplates, getTemplateVariables } from "../src/templates/index.js";
import { GraphSchema } from "../src/types.js";

describe("templates", () => {
  it("lists all available templates", () => {
    const templates = listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(4);
    for (const t of templates) {
      expect(t).toHaveProperty("name");
      expect(t).toHaveProperty("description");
      expect(t).toHaveProperty("tweakable");
    }
  });

  it("returns a valid graph for each template", () => {
    const templates = listTemplates();
    for (const t of templates) {
      const graph = getTemplate(t.name);
      expect(graph).not.toBeNull();
      const result = GraphSchema.safeParse(graph);
      expect(result.success, `Template "${t.name}" produces invalid graph: ${result.error?.message}`).toBe(true);
    }
  });

  it("returns null for unknown template", () => {
    expect(getTemplate("nonexistent")).toBeNull();
  });

  it("applies overrides to template params", () => {
    const graph = getTemplate("desert", { Seed: 42 });
    expect(graph).not.toBeNull();
    const seedNode = graph!.nodes.find(n => n.params?.Seed !== undefined);
    expect(seedNode?.params?.Seed).toBe(42);
  });
});

describe("template variable contracts", () => {
  it("listTemplates includes variables for all templates", () => {
    const templates = listTemplates();
    for (const t of templates) {
      expect(t.variables, `${t.name} is missing variables contract`).toBeDefined();
      expect(Object.keys(t.variables!).length).toBeGreaterThan(0);
    }
  });

  it("mountains contract has Seed, Scale, ErosionStrength", () => {
    const templates = listTemplates();
    const mountains = templates.find(t => t.name === "mountains")!;
    expect(mountains.variables!.Seed.type).toBe("Int");
    expect(mountains.variables!.Scale.type).toBe("Float");
    expect(mountains.variables!.ErosionStrength.type).toBe("Float");
  });

  it("getTemplateVariables returns contract for a named template", () => {
    const vars = getTemplateVariables("desert");
    expect(vars).toBeDefined();
    expect(vars!.Seed).toBeDefined();
  });

  it("getTemplateVariables returns null for unknown template", () => {
    expect(getTemplateVariables("nonexistent")).toBeNull();
  });
});

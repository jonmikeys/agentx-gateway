import { describe, expect, it } from "vitest";
import {
  invalidReferences,
  isValidReference,
  renderTemplate,
  resolvePath,
  templateReferences,
  variableSuggestions,
} from "@/lib/agents/templates";

describe("templates", () => {
  const scope = {
    input: { text: "hello", sessionId: "s-1" },
    vars: { name: "Ada", nested: { count: 2 }, items: ["a", "b"] },
    memory: { tone: "friendly" },
    nodes: { llm_1: { output: "model text" } },
  };

  it("interpolates dotted paths and renders missing paths as empty", () => {
    expect(renderTemplate("Hi {{input.text}} / {{vars.name}}", scope)).toBe("Hi hello / Ada");
    expect(renderTemplate("[{{vars.missing}}]", scope)).toBe("[]");
    expect(renderTemplate("{{ vars.nested.count }}", scope)).toBe("2");
    expect(renderTemplate("{{vars.items.1}}", scope)).toBe("b");
  });

  it("never evaluates expressions", () => {
    expect(renderTemplate("{{vars.constructor}}", scope)).toBe("");
    expect(renderTemplate("{{input.text.toUpperCase()}}", scope)).toBe("");
    expect(renderTemplate("{{process.env.SECRET}}", scope)).toBe("");
  });

  it("lists unique references in order", () => {
    expect(templateReferences("{{a.b}} x {{a.b}} y {{c}}")).toEqual(["a.b", "c"]);
  });

  it("resolves paths safely", () => {
    expect(resolvePath(scope, "vars.items.0")).toBe("a");
    expect(resolvePath(scope, "vars.items.9")).toBeUndefined();
    expect(resolvePath(scope, "vars.nested.count")).toBe(2);
  });

  it("flags references the editor cannot resolve", () => {
    expect(invalidReferences("{{input.text}} {{vars.x}} {{nope.x}}", ["llm_1"])).toEqual([
      "nope.x",
    ]);
    expect(invalidReferences("{{nodes.llm_1.output}}", ["llm_1"])).toEqual([]);
    expect(invalidReferences("{{nodes.ghost.output}}", ["llm_1"])).toEqual(["nodes.ghost.output"]);
    expect(isValidReference("nodes.llm_1.output", ["llm_1"])).toBe(true);
  });

  it("suggests input fields, variables, memory and node outputs", () => {
    const suggestions = variableSuggestions([{ id: "llm_1", title: "LLM" }], ["name"]);
    const paths = suggestions.map((entry) => entry.path);
    expect(paths).toContain("input.text");
    expect(paths).toContain("vars.name");
    expect(paths).toContain("memory.key");
    expect(paths).toContain("nodes.llm_1.output");
  });
});

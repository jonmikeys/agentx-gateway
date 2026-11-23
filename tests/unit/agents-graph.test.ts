import { describe, expect, it } from "vitest";
import { createFlowNode, plural, summarizeNode } from "@/lib/agents/graph";

describe("agent graph summaries", () => {
  it("pluralizes counts correctly", () => {
    expect(plural(1, "label")).toBe("1 label");
    expect(plural(2, "label")).toBe("2 labels");
    expect(plural(1, "rule")).toBe("1 rule");
    expect(plural(0, "step")).toBe("0 steps");
  });

  it("summarizes a router with one intent label without the plural s", () => {
    const router = createFlowNode(
      "router",
      { x: 0, y: 0 },
      {
        mode: "intent",
        intentLabels: ["smalltalk"],
        rules: [],
      },
    );
    expect(summarizeNode(router)).toBe("Intent · 1 label");
    expect(summarizeNode(router)).not.toContain("labels");
  });

  it("summarizes router rules with correct pluralization", () => {
    const oneRule = createFlowNode(
      "router",
      { x: 0, y: 0 },
      {
        mode: "rules",
        rules: [{ id: "r1", label: "One", operator: "contains", subject: "", value: "" }],
      },
    );
    expect(summarizeNode(oneRule)).toBe("Rules · 1 rule");
    const twoRules = createFlowNode(
      "router",
      { x: 0, y: 0 },
      {
        mode: "rules",
        rules: [
          { id: "r1", label: "One", operator: "contains", subject: "", value: "" },
          { id: "r2", label: "Two", operator: "contains", subject: "", value: "" },
        ],
      },
    );
    expect(summarizeNode(twoRules)).toBe("Rules · 2 rules");
  });
});

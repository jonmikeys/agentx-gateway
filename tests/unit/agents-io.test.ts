import { describe, expect, it } from "vitest";
import { createFlowNode, type FlowGraph } from "@/lib/agents/graph";
import { buildExportPayload, parseImportedFlow, stripGraphForExport } from "@/lib/agents/io";

const meta = {
  name: "Lobby greeter",
  slug: "lobby-greeter",
  kind: "agent" as const,
  description: "Says hello",
  settings: { default_route_slug: null, allowed_media_tags: [], allowed_cameras: [] },
  version: 2,
};

function webhookGraph(headerValue?: string): FlowGraph {
  const start = createFlowNode("start", { x: 0, y: 0 });
  const webhook = createFlowNode(
    "webhook",
    { x: 260, y: 0 },
    {
      title: "Check status",
      url: "https://lobby.internal/status",
      headers: [{ name: "X-Api-Key", ...(headerValue ? { value: headerValue } : {}) }],
    },
  );
  const end = createFlowNode("end", { x: 520, y: 0 });
  return {
    nodes: [start, webhook, end],
    edges: [
      { id: "e1", source: start.id, target: webhook.id, sourceHandle: "out" },
      { id: "e2", source: webhook.id, target: end.id, sourceHandle: "out" },
    ],
  };
}

describe("chatflow JSON export", () => {
  it("strips webhook header values and masks", () => {
    const graph = webhookGraph("super-secret-value");
    const webhook = graph.nodes.find((node) => node.type === "webhook");
    if (webhook?.type !== "webhook") throw new Error("fixture broken");
    webhook.data.headers = [{ name: "X-Api-Key", value: "super-secret-value", masked: "••••" }];

    const stripped = stripGraphForExport(graph);
    const strippedWebhook = stripped.nodes.find((node) => node.type === "webhook");
    if (strippedWebhook?.type !== "webhook") throw new Error("fixture broken");
    expect(strippedWebhook.data.headers).toEqual([{ name: "X-Api-Key" }]);
    expect(JSON.stringify(stripped)).not.toContain("super-secret-value");
    expect(JSON.stringify(stripped)).not.toContain("••••");

    const payload = buildExportPayload(meta, graph);
    expect(JSON.stringify(payload)).not.toContain("super-secret-value");
    expect(payload.graph.nodes.find((node) => node.type === "webhook")).toMatchObject({
      data: { headers: [{ name: "X-Api-Key" }] },
    });
  });
});

describe("chatflow JSON import", () => {
  it("accepts an exported payload and lists webhook headers to re-link", () => {
    const payload = JSON.stringify(buildExportPayload(meta, webhookGraph()));
    const result = parseImportedFlow(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flow.name).toBe("Lobby greeter");
    expect(result.flow.kind).toBe("agent");
    expect(result.flow.missingSecrets).toEqual(["Check status: X-Api-Key"]);
    expect(result.flow.graph.nodes).toHaveLength(3);
  });

  it("accepts a bare React Flow graph and defaults the metadata", () => {
    const graph = webhookGraph();
    const result = parseImportedFlow(JSON.stringify(graph));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flow.name).toBe("Imported chatflow");
    expect(result.flow.settings.allowed_media_tags).toEqual([]);
  });

  it("rejects malformed JSON", () => {
    const result = parseImportedFlow("{not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/Not valid JSON/);
  });

  it("rejects an invalid flow with per-node validation problems", () => {
    const reply = createFlowNode("reply", { x: 0, y: 0 }, { template: "hi" });
    const result = parseImportedFlow(JSON.stringify({ nodes: [reply], edges: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((problem) => problem.message.includes("Start"))).toBe(true);
  });
});

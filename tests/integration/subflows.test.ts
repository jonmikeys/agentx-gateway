import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createFlowNode, type FlowGraph, type FlowNode, type NodeType } from "@/lib/agents/graph";
import { createApiApp } from "@/server/api/app";
import { closeDatabase, getDb } from "@/server/db/client";
import { runLogs } from "@/server/db/schema";
import {
  createFlow,
  deleteFlow,
  getFlow,
  listPublishedAgents,
  listSubflowUsage,
  publishFlow,
  saveDraft,
} from "@/server/services/agents";
import { type MockUpstream, startMockUpstream } from "../support/mock-upstream";
import {
  prepareDatabase,
  resetGatewayState,
  seedApiKey,
  seedProvider,
  seedRoute,
  waitFor,
} from "./support";

const databaseUrl = inject("databaseUrl");

function node(type: NodeType, overrides: Record<string, unknown> = {}): FlowNode {
  return createFlowNode(type, { x: 0, y: 0 }, overrides);
}

function graph(nodes: FlowNode[], edges: [string, string, string?][]): FlowGraph {
  return {
    nodes,
    edges: edges.map(([source, target, handle], index) => ({
      id: `e${index}`,
      source,
      target,
      sourceHandle: handle ?? "out",
    })),
  };
}

function sseText(body: string): string {
  let text = "";
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") continue;
    const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === "string") text += delta;
  }
  return text;
}

describe("subflows: runtime, pinning and references", () => {
  const app = createApiApp();
  let upstream: MockUpstream;
  let key: string;
  let counter = 0;

  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    upstream = await startMockUpstream();
  });

  afterAll(async () => {
    await resetGatewayState();
    await upstream.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await resetGatewayState();
    upstream.reset();
    const provider = await seedProvider("Subflow mock", upstream.url);
    await seedRoute(`subflow-route-${counter}`, [{ providerId: provider.id, model: "ok" }]);
    counter += 1;
    key = (await seedApiKey()).key;
  });

  async function publishFlowOfKind(
    kind: "agent" | "subflow",
    nodes: FlowNode[],
    edges: [string, string, string?][],
    name = `${kind} ${counter}`,
  ) {
    const flow = await createFlow({
      name,
      slug: `${kind}-${counter}-${Date.now().toString(36)}`,
      kind,
      description: "",
      enabled: true,
      settings: {},
    });
    counter += 1;
    await saveDraft(flow.id, graph(nodes, edges));
    const published = await publishFlow(flow.id, "test");
    return { id: flow.id, version: published.version };
  }

  function chat(body: Record<string, unknown>) {
    return app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function responses(body: Record<string, unknown>) {
    return app.request("/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function replyText(response: Response): Promise<string> {
    return ((await response.json()) as { choices: { message: { content: string } }[] }).choices[0]
      .message.content;
  }

  /** A subflow that replies, writes memory, sets a local var and returns its input. */
  function greetingSubflow(): { nodes: FlowNode[]; edges: [string, string, string?][] } {
    const input = node("subflow_input", {
      params: [{ name: "topic", type: "string", required: true }],
    });
    const reply = node("reply", { template: "sub:{{vars.topic}};shared={{vars.shared}}" });
    const memory = node("memory", {
      operation: "set",
      key: "greeting",
      value: "hi",
      outputVariable: "stored",
    });
    const local = node("set_variable", { assignments: [{ key: "subvar", value: "from-sub" }] });
    const output = node("subflow_output", {
      label: "done",
      values: [{ name: "nested", value: "{{vars.topic}}" }],
    });
    return {
      nodes: [input, reply, memory, local, output],
      edges: [
        [input.id, reply.id],
        [reply.id, memory.id],
        [memory.id, local.id],
        [local.id, output.id],
      ],
    };
  }

  function callingAgent(subflowId: string) {
    const start = node("start");
    const setter = node("set_variable", {
      assignments: [{ key: "shared", value: "from-parent" }],
    });
    const call = node("call_subflow", {
      subflowId,
      subflowName: "Greeter",
      inputs: [{ name: "topic", value: "{{input.text}}" }],
      outputs: [{ label: "done", variable: "nested" }],
    });
    const memory = node("memory", {
      operation: "get",
      key: "greeting",
      outputVariable: "greet",
    });
    const reply = node("reply", {
      template:
        "done={{vars.nested}};shared={{vars.shared}};sub={{vars.subvar}};mem={{vars.greet}}",
    });
    const end = node("end");
    return {
      nodes: [start, setter, call, memory, reply, end],
      edges: [
        [start.id, setter.id],
        [setter.id, call.id],
        [call.id, memory.id, "out:done"],
        [memory.id, reply.id],
        [reply.id, end.id],
      ] as [string, string, string?][],
    };
  }

  it("runs a subflow from an agent over chat and responses with shared memory and isolated vars", async () => {
    const subflow = greetingSubflow();
    const subflowFlow = await publishFlowOfKind("subflow", subflow.nodes, subflow.edges);
    const agent = callingAgent(subflowFlow.id);
    const agentFlow = await publishFlowOfKind("agent", agent.nodes, agent.edges);

    const expected = "sub:child;shared=done=child;shared=from-parent;sub=;mem=hi";

    const json = await chat({
      agent_id: agentFlow.id,
      messages: [{ role: "user", content: "child" }],
    });
    expect(json.status).toBe(200);
    expect(await replyText(json)).toBe(expected);
    const sessionId = json.headers.get("x-session-id") as string;

    const streamed = await chat({
      model: `agent:${agentFlow.id}`,
      stream: true,
      messages: [{ role: "user", content: "child" }],
    });
    expect(sseText(await streamed.text())).toBe(expected);

    const response = await responses({
      model: `agent:${agentFlow.id}`,
      input: [{ role: "user", content: "child" }],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      output: { type: string; content?: { type: string; text: string }[] }[];
    };
    const message = body.output.find((item) => item.type === "message");
    expect(message?.content?.[0]?.text).toBe(expected);

    // The trace nests the subflow steps under the Call Subflow step.
    const log = await waitFor(async () => {
      const rows = await getDb().select().from(runLogs).where(eq(runLogs.sessionId, sessionId));
      return rows[0];
    });
    const callStep = log.trace?.steps.find((step) => step.node_type === "call_subflow");
    expect(callStep?.substeps?.map((step) => step.node_type)).toContain("reply");
    expect(callStep?.substeps?.some((step) => step.node_type === "subflow_output")).toBe(true);
  });

  it("branches on multiple Subflow Output labels", async () => {
    const input = node("subflow_input", {
      params: [{ name: "topic", type: "string", required: true }],
    });
    const router = node("router", {
      rules: [
        {
          id: "yes",
          label: "Yes",
          operator: "contains",
          subject: "{{input.text}}",
          value: "yes",
        },
      ],
      defaultLabel: "No",
    });
    const yesOut = node("subflow_output", {
      label: "yes",
      values: [{ name: "value", value: "{{input.text}}" }],
    });
    const noOut = node("subflow_output", {
      label: "no",
      values: [{ name: "reason", value: "none" }],
    });
    const subflow = await publishFlowOfKind(
      "subflow",
      [input, router, yesOut, noOut],
      [
        [input.id, router.id],
        [router.id, yesOut.id, "yes"],
        [router.id, noOut.id, "default"],
      ],
    );

    const start = node("start");
    const call = node("call_subflow", {
      subflowId: subflow.id,
      inputs: [{ name: "topic", value: "{{input.text}}" }],
      outputs: [
        { label: "yes", variable: "yes_value" },
        { label: "no", variable: "no_reason" },
      ],
    });
    const yesReply = node("reply", { template: "YES:{{vars.yes_value}}" });
    const noReply = node("reply", { template: "NO:{{vars.no_reason}}" });
    const end = node("end");
    const agent = await publishFlowOfKind(
      "agent",
      [start, call, yesReply, noReply, end],
      [
        [start.id, call.id],
        [call.id, yesReply.id, "out:yes"],
        [call.id, noReply.id, "out:no"],
        [yesReply.id, end.id],
        [noReply.id, end.id],
      ],
    );

    expect(
      await replyText(
        await chat({ agent_id: agent.id, messages: [{ role: "user", content: "say yes" }] }),
      ),
    ).toBe("YES:say yes");
    expect(
      await replyText(
        await chat({ agent_id: agent.id, messages: [{ role: "user", content: "nope" }] }),
      ),
    ).toBe("NO:none");
  });

  it("runs the pinned subflow version until the caller is republished", async () => {
    const v1Input = node("subflow_input");
    const v1Out = node("subflow_output", {
      label: "done",
      values: [{ name: "text", value: "v1-text" }],
    });
    const subflowFlow = await publishFlowOfKind(
      "subflow",
      [v1Input, v1Out],
      [[v1Input.id, v1Out.id]],
    );

    const start = node("start");
    const call = node("call_subflow", {
      subflowId: subflowFlow.id,
      outputs: [{ label: "done", variable: "res" }],
    });
    const reply = node("reply", { template: "{{vars.res}}" });
    const end = node("end");
    const agent = await publishFlowOfKind(
      "agent",
      [start, call, reply, end],
      [
        [start.id, call.id],
        [call.id, reply.id, "out:done"],
        [reply.id, end.id],
      ],
    );

    expect(
      await replyText(
        await chat({ agent_id: agent.id, messages: [{ role: "user", content: "go" }] }),
      ),
    ).toBe("v1-text");
    expect((await getFlow(agent.id)).pinned_subflows[subflowFlow.id]).toBe(1);

    // A new subflow version (v2) must not change the published agent.
    const flow = await getFlow(subflowFlow.id);
    const v2Out = node("subflow_output", {
      label: "done",
      values: [{ name: "text", value: "v2-text" }],
    });
    await saveDraft(flow.id, graph([v1Input, v2Out], [[v1Input.id, v2Out.id]]));
    await publishFlow(flow.id, "v2");

    expect(
      await replyText(
        await chat({ agent_id: agent.id, messages: [{ role: "user", content: "go" }] }),
      ),
    ).toBe("v1-text");
    expect((await getFlow(agent.id)).pinned_subflows[subflowFlow.id]).toBe(1);

    // Republishing the agent captures the new pin.
    await publishFlow(agent.id, "bump pin");
    expect((await getFlow(agent.id)).pinned_subflows[subflowFlow.id]).toBe(2);
    expect(
      await replyText(
        await chat({ agent_id: agent.id, messages: [{ role: "user", content: "go" }] }),
      ),
    ).toBe("v2-text");
  });

  it("rejects call cycles and nesting deeper than five levels", async () => {
    const leafInput = node("subflow_input");
    const leafOut = node("subflow_output", { label: "result" });
    const a = await publishFlowOfKind(
      "subflow",
      [leafInput, leafOut],
      [[leafInput.id, leafOut.id]],
      "Cycle A",
    );
    const bInput = node("subflow_input");
    const bCall = node("call_subflow", {
      subflowId: a.id,
      outputs: [{ label: "result", variable: "x" }],
    });
    const bOut = node("subflow_output", { label: "result" });
    const b = await publishFlowOfKind(
      "subflow",
      [bInput, bCall, bOut],
      [
        [bInput.id, bCall.id],
        [bCall.id, bOut.id, "out:result"],
      ],
      "Cycle B",
    );

    // A draft that calls B closes the A -> B -> A cycle.
    const aFlow = await getFlow(a.id);
    const aCall = node("call_subflow", {
      subflowId: b.id,
      outputs: [{ label: "result", variable: "x" }],
    });
    const aOut = node("subflow_output", { label: "result" });
    await saveDraft(
      aFlow.id,
      graph(
        [leafInput, aCall, aOut],
        [
          [leafInput.id, aCall.id],
          [aCall.id, aOut.id, "out:result"],
        ],
      ),
    );
    await expect(publishFlow(aFlow.id, "cycle")).rejects.toMatchObject({
      status: 400,
      code: "flow_invalid",
      details: [expect.objectContaining({ message: expect.stringContaining("cycle") })],
    });

    // Build a chain longer than the depth limit and publish it through an agent.
    let previous: string | undefined;
    for (let level = 7; level >= 2; level -= 1) {
      const chainInput = node("subflow_input");
      const chainOut = node("subflow_output", { label: "result" });
      const chainNodes = [chainInput, chainOut];
      const chainEdges: [string, string, string?][] = [[chainInput.id, chainOut.id]];
      if (previous) {
        const chainCall = node("call_subflow", {
          subflowId: previous,
          outputs: [{ label: "result", variable: "x" }],
        });
        chainNodes.push(chainCall);
        chainEdges.push([chainInput.id, chainCall.id], [chainCall.id, chainOut.id, "out:result"]);
      }
      const published = await publishFlowOfKind(
        "subflow",
        chainNodes,
        chainEdges,
        `Depth ${level}`,
      );
      previous = published.id;
    }

    const depthStart = node("start");
    const depthCall = node("call_subflow", {
      subflowId: previous as string,
      outputs: [{ label: "result", variable: "x" }],
    });
    const depthReply = node("reply", { template: "deep" });
    const depthEnd = node("end");
    const depthAgent = await createFlow({
      name: "Depth agent",
      slug: `depth-agent-${Date.now().toString(36)}`,
      kind: "agent",
      description: "",
      enabled: true,
      settings: {},
    });
    await saveDraft(
      depthAgent.id,
      graph(
        [depthStart, depthCall, depthReply, depthEnd],
        [
          [depthStart.id, depthCall.id],
          [depthCall.id, depthReply.id, "out:result"],
          [depthReply.id, depthEnd.id],
        ],
      ),
    );
    await expect(publishFlow(depthAgent.id, "too deep")).rejects.toMatchObject({
      status: 400,
      code: "flow_invalid",
      details: [expect.objectContaining({ message: expect.stringContaining("deeper than 5") })],
    });
  });

  it("lists usage, hides subflows from the client API and blocks deletion while referenced", async () => {
    const subflow = greetingSubflow();
    const subflowFlow = await publishFlowOfKind("subflow", subflow.nodes, subflow.edges);
    const agent = callingAgent(subflowFlow.id);
    const agentFlow = await publishFlowOfKind("agent", agent.nodes, agent.edges);

    const agents = (await (
      await app.request("/v1/agents", { headers: { Authorization: `Bearer ${key}` } })
    ).json()) as { data: { id: string }[] };
    expect(agents.data.map((entry) => entry.id)).not.toContain(subflowFlow.id);
    expect((await listPublishedAgents()).map((entry) => entry.id)).not.toContain(subflowFlow.id);

    const models = (await (
      await app.request("/v1/models", { headers: { Authorization: `Bearer ${key}` } })
    ).json()) as { data: { id: string }[] };
    expect(models.data.map((entry) => entry.id)).not.toContain(`agent:${subflowFlow.id}`);

    const asAgent = await chat({
      agent_id: subflowFlow.id,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(asAgent.status).toBe(400);
    expect(((await asAgent.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_agent",
    );

    const usage = await listSubflowUsage(subflowFlow.id);
    expect(usage).toContainEqual(
      expect.objectContaining({
        flow_id: agentFlow.id,
        version: 1,
        pinned_version: 1,
      }),
    );

    await expect(deleteFlow(subflowFlow.id)).rejects.toMatchObject({
      status: 409,
      code: "flow_in_use",
      details: [expect.objectContaining({ flow_id: agentFlow.id })],
    });
  });
});

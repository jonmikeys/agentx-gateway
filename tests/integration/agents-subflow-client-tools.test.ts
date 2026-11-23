import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createFlowNode, type FlowGraph, type FlowNode, type NodeType } from "@/lib/agents/graph";
import { registerAgentPurgeHooks } from "@/server/agents/purge";
import { createApiApp } from "@/server/api/app";
import { closeDatabase, getDb } from "@/server/db/client";
import { cameras, mediaItems } from "@/server/db/schema";
import { createFlow, publishFlow, saveDraft } from "@/server/services/agents";
import { type MockUpstream, startMockUpstream } from "../support/mock-upstream";
import { prepareDatabase, resetGatewayState, seedApiKey, seedProvider, seedRoute } from "./support";

const databaseUrl = inject("databaseUrl");

const MEDIA_ALLOWED = "med_aaaaaaaaaaaa";
const MEDIA_OTHER = "med_bbbbbbbbbbbb";

const showImageTool = {
  type: "function",
  function: {
    name: "show_image",
    description: "Show an image.",
    parameters: {
      type: "object",
      properties: { media_id: { type: "string" } },
      required: ["media_id"],
    },
  },
};

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

interface ChatBody {
  choices: {
    message: { content: string | null; tool_calls?: unknown[] };
    finish_reason: string;
  }[];
}

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

function toolCallMessage(callId: string, name: string, args: string) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: callId, type: "function", function: { name, arguments: args } }],
  };
}

/**
 * Cross-slice tests: a client (Unity) tool pause that fires *inside* a called subflow must pause
 * the whole run, hand the calls to the client, and resume back inside the subflow so its output
 * returns to the parent agent. Covers LLM nodes and Client Action nodes, chat and Responses, plus
 * the calling agent's media restrictions reaching Client Actions in a subflow.
 */
describe("agents calling subflows that pause for client tools", () => {
  const app = createApiApp();
  let upstream: MockUpstream;
  let key: string;
  let counter = 0;

  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    registerAgentPurgeHooks();
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
    const provider = await seedProvider("Subflow client mock", upstream.url);
    await seedRoute("subflow-client-route", [{ providerId: provider.id, model: "tool-call" }]);
    key = (await seedApiKey()).key;
    await getDb()
      .insert(mediaItems)
      .values([
        {
          id: MEDIA_ALLOWED,
          name: "Allowed",
          kind: "image",
          tags: ["allowed"],
          enabled: true,
          source: "external_url",
          externalUrl: "https://example.com/allowed.png",
          mimeType: "image/png",
        },
        {
          id: MEDIA_OTHER,
          name: "Other",
          kind: "image",
          tags: ["other"],
          enabled: true,
          source: "external_url",
          externalUrl: "https://example.com/other.png",
          mimeType: "image/png",
        },
      ]);
    await getDb().insert(cameras).values({
      id: "cam_aaaaaaaaaaaa",
      name: "Lobby",
      enabled: true,
      type: "lookat_sidecar",
      config: {},
    });
  });

  async function publish(
    kind: "agent" | "subflow",
    nodes: FlowNode[],
    edges: [string, string, string?][],
    settings: Record<string, unknown> = {},
  ): Promise<string> {
    counter += 1;
    const flow = await createFlow({
      name: `${kind} ${counter}`,
      slug: `${kind}-${counter}-${Date.now().toString(36)}`,
      kind,
      description: "",
      enabled: true,
      settings,
    });
    await saveDraft(flow.id, graph(nodes, edges));
    await publishFlow(flow.id, "test");
    return flow.id;
  }

  function agentSettings(tags: string[] = []) {
    return { default_route_slug: "subflow-client-route", allowed_media_tags: tags };
  }

  /** A published subflow whose LLM node offers the request's client tools, then returns. */
  async function llmSubflow(): Promise<string> {
    const input = node("subflow_input", {
      params: [{ name: "topic", type: "string", required: true }],
    });
    const llm = node("llm", {
      model: "inherit",
      outputVariable: "answer",
      clientTools: { mode: "all", names: [] },
    });
    const output = node("subflow_output", {
      label: "done",
      values: [{ name: "answer", value: "{{vars.answer}}" }],
    });
    return publish(
      "subflow",
      [input, llm, output],
      [
        [input.id, llm.id],
        [llm.id, output.id],
      ],
    );
  }

  /** An agent that calls `subflowId`, maps its `done` output and replies with it. */
  async function callingAgent(subflowId: string, tags: string[] = []): Promise<string> {
    const start = node("start");
    const call = node("call_subflow", {
      subflowId,
      inputs: [{ name: "topic", value: "{{input.text}}" }],
      outputs: [{ label: "done", variable: "res" }],
    });
    const reply = node("reply", { template: "Sub said: {{vars.res}}" });
    const end = node("end");
    return publish(
      "agent",
      [start, call, reply, end],
      [
        [start.id, call.id],
        [call.id, reply.id, "out:done"],
        [reply.id, end.id],
      ],
      agentSettings(tags),
    );
  }

  function chat(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  function responses(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return app.request("/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("pauses inside a subflow's LLM node and resumes back into it over chat", async () => {
    const subflowId = await llmSubflow();
    const agentId = await callingAgent(subflowId);

    const first = await chat({
      agent_id: agentId,
      messages: [{ role: "user", content: "Show a sunset" }],
      tools: [showImageTool],
    });
    expect(first.status).toBe(200);
    const sessionId = first.headers.get("x-session-id") as string;
    const firstBody = (await first.json()) as ChatBody;
    expect(firstBody.choices[0].finish_reason).toBe("tool_calls");
    const call = (firstBody.choices[0].message.tool_calls as ToolCall[])[0];
    expect(call.function.name).toBe("show_image");
    expect(JSON.parse(call.function.arguments)).toEqual({ media_id: "sunset" });

    const second = await chat(
      {
        agent_id: agentId,
        messages: [
          { role: "user", content: "Show a sunset" },
          toolCallMessage(call.id, "show_image", call.function.arguments),
          { role: "tool", tool_call_id: call.id, content: '{"ok":true}' },
        ],
        tools: [showImageTool],
      },
      { "X-Session-Id": sessionId },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as ChatBody;
    expect(secondBody.choices[0].message.content).toContain(
      "Sub said: Done! I put the image on screen.",
    );
  });

  it("pauses inside a subflow's LLM node and resumes over the Responses API", async () => {
    const subflowId = await llmSubflow();
    const agentId = await callingAgent(subflowId);

    const responsesTool = {
      type: "function",
      name: "show_image",
      description: "Show an image.",
      parameters: showImageTool.function.parameters,
    };
    const first = await responses({
      agent_id: agentId,
      input: [{ role: "user", content: "Show a sunset" }],
      tools: [responsesTool],
    });
    expect(first.status).toBe(200);
    const sessionId = first.headers.get("x-session-id") as string;
    const firstBody = (await first.json()) as {
      output: { type: string; call_id?: string; name?: string; arguments?: string }[];
    };
    const call = firstBody.output.find((item) => item.type === "function_call");
    expect(call?.name).toBe("show_image");

    const second = await responses(
      {
        agent_id: agentId,
        input: [
          { type: "message", role: "user", content: "Show a sunset" },
          {
            type: "function_call",
            call_id: call?.call_id,
            name: "show_image",
            arguments: call?.arguments,
          },
          { type: "function_call_output", call_id: call?.call_id, output: '{"ok":true}' },
        ],
        tools: [responsesTool],
      },
      { "X-Session-Id": sessionId },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      output: { type: string; content?: { type: string; text: string }[] }[];
    };
    const message = secondBody.output.find((item) => item.type === "message");
    expect(message?.content?.[0]?.text).toContain("Sub said: Done! I put the image on screen.");
  });

  it("pauses inside a subflow's Client Action node and resumes back into it", async () => {
    const input = node("subflow_input");
    const action = node("client_action", {
      toolName: "show_image",
      argsTemplate: `{"media_id":"${MEDIA_ALLOWED}"}`,
      outputVariable: "shown",
    });
    const output = node("subflow_output", {
      label: "done",
      values: [{ name: "ok", value: "{{vars.shown.ok}}" }],
    });
    const subflowId = await publish(
      "subflow",
      [input, action, output],
      [
        [input.id, action.id],
        [action.id, output.id],
      ],
    );
    const agentId = await callingAgent(subflowId);

    const first = await chat({ agent_id: agentId, messages: [{ role: "user", content: "Go" }] });
    const sessionId = first.headers.get("x-session-id") as string;
    const firstBody = (await first.json()) as ChatBody;
    expect(firstBody.choices[0].finish_reason).toBe("tool_calls");
    const call = (firstBody.choices[0].message.tool_calls as ToolCall[])[0];
    expect(call.function.name).toBe("show_image");
    expect(JSON.parse(call.function.arguments)).toEqual({ media_id: MEDIA_ALLOWED });

    const second = await chat(
      {
        agent_id: agentId,
        messages: [
          { role: "user", content: "Go" },
          toolCallMessage(call.id, "show_image", call.function.arguments),
          { role: "tool", tool_call_id: call.id, content: '{"ok":true}' },
        ],
      },
      { "X-Session-Id": sessionId },
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as ChatBody).choices[0].message.content).toBe("Sub said: true");
  });

  it("applies the calling agent's restrictions to a Client Action inside a subflow", async () => {
    // The subflow itself has no restrictions, so it publishes; the action targets media outside
    // the tag set that the *calling* agent allows.
    const input = node("subflow_input");
    const action = node("client_action", {
      toolName: "show_image",
      argsTemplate: `{"media_id":"${MEDIA_OTHER}"}`,
      outputVariable: "shown",
    });
    const output = node("subflow_output", {
      label: "done",
      values: [{ name: "ok", value: "{{vars.shown.ok}}" }],
    });
    const subflowId = await publish(
      "subflow",
      [input, action, output],
      [
        [input.id, action.id],
        [action.id, output.id],
      ],
    );
    const agentId = await callingAgent(subflowId, ["allowed"]);

    const response = await chat({
      agent_id: agentId,
      messages: [{ role: "user", content: "Go" }],
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("agent_run_failed");
    expect(body.error.message).toContain("outside the agent's allowed media tags");
  });
});

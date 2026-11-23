import { randomUUID } from "node:crypto";
import {
  type ClientToolCall,
  type ClientToolDefinition,
  type ClientToolRestrictions,
  type ClientToolResult,
  clientActionProblem,
  parseToolResultContent,
  renderClientActionArgs,
  restrictClientTools,
  selectClientTools,
  toolResultFailed,
  UNRESTRICTED,
} from "@/lib/agents/client-tools";
import {
  type FlowGraph,
  type FlowNode,
  isFallibleNode,
  nodeHandles,
  type SubflowParamType,
  subflowOutputHandle,
} from "@/lib/agents/graph";
import { subflowParams } from "@/lib/agents/subflows";
import { renderTemplate, resolvePath, type TemplateScope } from "@/lib/agents/templates";
import type { RunTraceStep } from "@/lib/agents/types";
import { AgentRuntimeError, chatThroughRoute } from "@/server/agents/llm";
import type { MemoryStore } from "@/server/agents/memory";
import type { TokenUsage } from "@/server/db/schema";
import type { ResolvedMcpTool } from "@/server/services/mcp";
import type { ResolvedRoute } from "@/server/services/routes";

/** The LangGraph state shared by every node (spec §13: messages, sessionId, vars, memory, output). */
export interface AgentState {
  messages: unknown[];
  sessionId: string;
  vars: Record<string, unknown>;
  memory: Record<string, unknown>;
  output: unknown;
  /** Which output handle the last node chose; the conditional edge resolves it to a target. */
  cursor: string;
  trace: RunTraceStep[];
  /** Text already streamed to the client. */
  text: string;
  /** Accumulated token usage across LLM nodes in this run. */
  usage?: TokenUsage;
  /** Accumulated model reasoning text (stored in the transcript like a normal turn). */
  reasoning: string;
  lastError?: string;
  fatal: boolean;
  failedNodeId: string | null;
  /** Node whose client tool calls are waiting for the client (empty when none). */
  pendingClientNode: string;
  pendingClientCalls: ClientToolCall[];
  /** Tool results delivered by the resuming request, consumed by their originating node. */
  clientResults: ClientToolResult[];
  clientResultsNode: string;
}

export interface AgentDependencies {
  resolveRoute: (slug: string) => Promise<ResolvedRoute | undefined>;
  mcpToolsByIds: (ids: string[]) => Promise<ResolvedMcpTool[]>;
  mcpCall: (
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<{ text: string; isError: boolean }>;
  webhookHeaders: (flowId: string, nodeId: string) => Promise<Record<string, string>>;
  memory: MemoryStore;
  /** Loads one pinned published subflow version for a Call Subflow node. */
  loadSubflowVersion: (flowId: string, version: number) => Promise<SubflowVersion | undefined>;
  fetchImpl?: typeof fetch;
}

/** A published subflow version plus the subflows it pins, as the runtime needs it. */
export interface SubflowVersion {
  flowId: string;
  version: number;
  graph: FlowGraph;
  pinnedSubflows: Record<string, number>;
}

export interface SubflowRunRequest {
  subflow: SubflowVersion;
  /** Coerced Subflow Input params; they become the subflow's own vars. */
  inputs: Record<string, unknown>;
  /** Shared with the parent: session memory, conversation history and the user text. */
  sessionId: string;
  memory: Record<string, unknown>;
  messages: unknown[];
  inputText: string;
  parent: { flowId: string; version: number; depth: number };
  /** The Call Subflow node id (part of the nested checkpoint thread id). */
  nodeId: string;
  /** The caller's checkpoint thread; the subflow checkpoints under a child of it. */
  threadId: string;
  /** When true, discard any leftover checkpoint for this call before starting fresh. */
  reset: boolean;
  /** Client tool results to deliver when resuming a paused subflow. */
  resume?: ClientToolResult[];
}

export interface SubflowRunResult {
  /** Label of the Subflow Output the run reached ("" when none). */
  label: string;
  values: Record<string, unknown>;
  memory: Record<string, unknown>;
  text: string;
  reasoning: string;
  usage?: TokenUsage;
  steps: RunTraceStep[];
  /** Set when the subflow paused on a client tool; the caller must pause too. */
  paused?: { calls: ClientToolCall[] };
}

export interface AgentRunContext {
  flowId: string;
  version: number;
  sessionId: string;
  graph: FlowGraph;
  /** The latest user message, exposed as `{{input.text}}`. */
  inputText: string;
  /** Nodes whose generated text streams straight to the client (no Reply downstream). */
  terminalLlmNodes: Set<string>;
  route: ResolvedRoute | undefined;
  deps: AgentDependencies;
  /** Function tools the Unity client sent with the request (G7b). */
  clientTools?: ClientToolDefinition[];
  /** Resolved media/camera allow-lists for narrowing the offered client tool enums. */
  clientRestrictions?: ClientToolRestrictions;
  emitText: (delta: string) => void;
  /** Live node lifecycle events for the CRM test drawer and streaming callers. */
  onNodeStart?: (node: FlowNode) => void;
  onNodeEnd?: (step: RunTraceStep) => void;
  signal: AbortSignal;
  /** The checkpoint thread this graph runs under (session id at the top level). */
  threadId: string;
  /** Pins captured by the running flow version (subflow id -> version). */
  pinnedSubflows: Record<string, number>;
  /** 0 for the top-level flow, 1 inside the first nested subflow, and so on. */
  depth: number;
  /** Executes a nested subflow; supplied by the runtime (keeps this module cycle-free). */
  runSubflow?: (request: SubflowRunRequest) => Promise<SubflowRunResult>;
}

export interface NodeOutcome {
  /** Handle id to follow; defaults to `out`. */
  next?: string;
  vars?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  output?: unknown;
  /** Conversation accumulated by an LLM node, persisted so a resumed run continues from it. */
  messages?: unknown[];
  /** Set when the node paused for client tool results; the compiler routes to the wait node. */
  pendingClientNode?: string;
  pendingClientCalls?: ClientToolCall[];
  /** Cleared when a node consumes the resumed results. */
  clientResults?: ClientToolResult[];
  clientResultsNode?: string;
  /** Text emitted to the client this node; appended to the run reply. */
  emittedText?: string;
  reasoning?: string;
  usage?: TokenUsage;
  /** Nested subflow trace, attached to this node's step. */
  steps?: RunTraceStep[];
  /** Set by a Subflow Output node to end the subflow on a named branch. */
  subflowOutput?: { label: string; values: Record<string, unknown> };
}

export function addUsage(
  total: TokenUsage | undefined,
  usage: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!usage) return total;
  if (!total) return { ...usage };
  return {
    prompt_tokens: total.prompt_tokens + usage.prompt_tokens,
    completion_tokens: total.completion_tokens + usage.completion_tokens,
    total_tokens: total.total_tokens + usage.total_tokens,
  };
}

function scopeFor(state: AgentState, inputText: string): TemplateScope {
  return {
    input: { text: inputText, sessionId: state.sessionId },
    vars: state.vars,
    memory: state.memory,
    nodes: Object.fromEntries(
      Object.entries(state.vars).map(([key, value]) => [key, { output: value }]),
    ),
  };
}

function nodeOutputScope(state: AgentState): TemplateScope["nodes"] {
  const nodes: TemplateScope["nodes"] = {};
  for (const step of state.trace) {
    nodes[step.node_id] = { output: step.output ?? null };
  }
  return nodes;
}

function templateScope(state: AgentState, inputText: string): TemplateScope {
  const scope = scopeFor(state, inputText);
  return { ...scope, nodes: nodeOutputScope(state) };
}

function render(template: string, state: AgentState, inputText: string): string {
  return renderTemplate(template, templateScope(state, inputText));
}

function routeForModel(
  model: string,
  context: AgentRunContext,
): Promise<ResolvedRoute | undefined> {
  if (model === "inherit") return Promise.resolve(context.route);
  return context.deps.resolveRoute(model);
}

function historyMessages(
  state: AgentState,
  node: Extract<FlowNode, { type: "llm" }>,
  context: AgentRunContext,
): unknown[] {
  const history = state.messages;
  const nonSystem = history.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { role?: string }).role !== "system" &&
      (message as { role?: string }).role !== "developer",
  );
  const selected =
    node.data.history === "none"
      ? nonSystem.slice(-1)
      : node.data.history === "last_n"
        ? nonSystem.slice(-node.data.historyLimit)
        : history;
  const systemPrompt = render(node.data.systemPrompt, state, context.inputText).trim();
  return systemPrompt ? [{ role: "system", content: systemPrompt }, ...selected] : selected;
}

function toolDefinitions(tools: ResolvedMcpTool[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.exposedName,
      description: tool.description,
      parameters:
        typeof tool.inputSchema === "object" && tool.inputSchema !== null
          ? tool.inputSchema
          : { type: "object", properties: {} },
    },
  }));
}

function parseArgument(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

async function executeLlm(
  node: Extract<FlowNode, { type: "llm" }>,
  state: AgentState,
  context: AgentRunContext,
): Promise<NodeOutcome> {
  const route = await routeForModel(node.data.model, context);
  if (!route) {
    throw new AgentRuntimeError(
      "route_not_found",
      `Model route "${node.data.model}" does not exist or is disabled.`,
    );
  }
  const mcpTools = await context.deps.mcpToolsByIds(node.data.mcpToolIds);
  const mcpNames = new Set(mcpTools.map((tool) => tool.exposedName));
  const offered = restrictClientTools(
    selectClientTools(context.clientTools ?? [], node.data.clientTools),
    context.clientRestrictions ?? UNRESTRICTED,
  ).filter((tool) => !mcpNames.has(tool.function.name));
  const clientByName = new Map(offered.map((tool) => [tool.function.name, tool]));
  const hasTools = mcpTools.length > 0 || offered.length > 0;
  const streaming = !hasTools && node.data.stream && context.terminalLlmNodes.has(node.id);

  const resuming = state.clientResultsNode === node.id && state.clientResults.length > 0;
  let messages = resuming ? [...state.messages] : historyMessages(state, node, context);
  if (resuming) {
    for (const result of state.clientResults) {
      messages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content });
    }
  }
  const clearResults = resuming
    ? { clientResults: [] as ClientToolResult[], clientResultsNode: "" }
    : {};

  const mcpByName = new Map(mcpTools.map((tool) => [tool.exposedName, tool]));
  const toolList = hasTools ? [...toolDefinitions(mcpTools), ...offered] : undefined;
  let usageText = "";
  let reasoning = "";
  let usage: TokenUsage | undefined;

  const rounds = hasTools ? 4 : 1;
  for (let round = 0; round < rounds; round += 1) {
    const isLast = round === rounds - 1;
    const result = await chatThroughRoute({
      route,
      messages,
      tools: toolList,
      toolChoice: hasTools ? (isLast ? "none" : "auto") : undefined,
      stream: streaming,
      signal: context.signal,
      fetchImpl: context.deps.fetchImpl,
      onDelta: streaming ? (delta) => delta.text && context.emitText(delta.text) : undefined,
    });
    reasoning += result.reasoning;
    usage = addUsage(usage, result.usage);
    usageText = result.text;
    const calls = result.toolCalls.filter(
      (call) => call.name && (mcpByName.has(call.name) || clientByName.has(call.name)),
    );
    if (calls.length === 0 || !hasTools || isLast) break;

    const assistantCalls = calls.map((call, index) => ({
      id: call.id ?? `call_${round}_${index}`,
      type: "function",
      function: { name: call.name ?? "", arguments: call.rawArguments || "{}" },
    }));
    const toolMessages: unknown[] = [];
    const pendingCalls: ClientToolCall[] = [];
    for (const [index, call] of calls.entries()) {
      const name = call.name ?? "";
      if (clientByName.has(name)) {
        pendingCalls.push({
          id: assistantCalls[index].id,
          name,
          arguments: call.rawArguments || JSON.stringify(call.args ?? {}),
        });
        continue;
      }
      const tool = mcpByName.get(name);
      if (!tool) continue;
      const args =
        typeof call.args === "object" && call.args !== null
          ? (call.args as Record<string, unknown>)
          : {};
      let content: string;
      try {
        const executed = await context.deps.mcpCall(tool.server.id, tool.toolName, args);
        content = executed.text || "(empty result)";
      } catch (error) {
        content = `Error: ${error instanceof Error ? error.message : "MCP call failed"}`;
      }
      toolMessages.push({ role: "tool", tool_call_id: assistantCalls[index].id, content });
    }
    messages = [
      ...messages,
      { role: "assistant", content: result.text || null, tool_calls: assistantCalls },
      ...toolMessages,
    ];
    if (pendingCalls.length > 0) {
      return {
        messages,
        vars: { [node.data.outputVariable]: usageText },
        output: usageText,
        reasoning,
        usage,
        next: "out",
        pendingClientNode: node.id,
        pendingClientCalls: pendingCalls,
        ...clearResults,
      };
    }
  }

  const terminal = node.data.stream && context.terminalLlmNodes.has(node.id);
  return {
    messages,
    vars: { [node.data.outputVariable]: usageText },
    output: usageText,
    emittedText: streaming || terminal ? usageText : undefined,
    reasoning,
    usage,
    next: "out",
    ...clearResults,
  };
}

function safeRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    throw new AgentRuntimeError("router_invalid_regex", `Invalid regular expression: ${pattern}`);
  }
}

async function executeRouter(
  node: Extract<FlowNode, { type: "router" }>,
  state: AgentState,
  context: AgentRunContext,
): Promise<NodeOutcome> {
  if (node.data.mode === "rules") {
    for (const rule of node.data.rules) {
      const subject = render(rule.subject, state, context.inputText);
      const expected = render(rule.value, state, context.inputText);
      const matched =
        rule.operator === "equals"
          ? subject.trim() === expected.trim()
          : rule.operator === "contains"
            ? subject.includes(expected)
            : safeRegExp(expected).test(subject);
      if (matched) return { next: rule.id, output: rule.label };
    }
    return { next: "default", output: node.data.defaultLabel };
  }

  const route = await routeForModel(node.data.model, context);
  if (!route) {
    throw new AgentRuntimeError(
      "route_not_found",
      `Model route "${node.data.model}" does not exist or is disabled.`,
    );
  }
  const labels = node.data.intentLabels;
  const instruction = render(node.data.intentInstruction, state, context.inputText);
  const result = await chatThroughRoute({
    route,
    messages: [
      {
        role: "system",
        content: `${instruction}\n\nLabels: ${labels.join(", ")}. Answer with one label and nothing else.`,
      },
      { role: "user", content: context.inputText },
    ],
    stream: false,
    signal: context.signal,
    fetchImpl: context.deps.fetchImpl,
  });
  const answer = result.text.trim().toLowerCase();
  const chosen =
    labels.find((label) => answer === label.toLowerCase()) ??
    labels.find((label) => answer.includes(label.toLowerCase()));
  if (chosen)
    return {
      next: `intent:${chosen}`,
      output: chosen,
      usage: result.usage,
      reasoning: result.reasoning,
    };
  return {
    next: "default",
    output: node.data.defaultLabel,
    usage: result.usage,
    reasoning: result.reasoning,
  };
}

async function executeSetVariable(
  node: Extract<FlowNode, { type: "set_variable" }>,
  state: AgentState,
  context: AgentRunContext,
): Promise<NodeOutcome> {
  const vars: Record<string, unknown> = {};
  for (const assignment of node.data.assignments) {
    vars[assignment.key] = render(assignment.value, state, context.inputText);
  }
  return { vars, output: vars, next: "out" };
}

async function executeWebhook(
  node: Extract<FlowNode, { type: "webhook" }>,
  state: AgentState,
  context: AgentRunContext,
): Promise<NodeOutcome> {
  const url = render(node.data.url, state, context.inputText);
  const parsedUrl = URL.canParse(url) ? new URL(url) : undefined;
  if (!parsedUrl || !/^https?:$/.test(parsedUrl.protocol)) {
    throw new AgentRuntimeError("webhook_invalid_url", `Webhook URL is not a valid http(s) URL.`);
  }
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    ...(await context.deps.webhookHeaders(context.flowId, node.id)),
  };
  const bodyText = render(node.data.bodyTemplate, state, context.inputText);
  if (node.data.method !== "GET" && bodyText.trim() !== "") {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }
  const attempts = node.data.retries + 1;
  let lastMessage = "Webhook failed";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), node.data.timeoutMs);
    try {
      const response = await (context.deps.fetchImpl ?? fetch)(parsedUrl, {
        method: node.data.method,
        headers,
        body: node.data.method === "GET" || bodyText.trim() === "" ? undefined : bodyText,
        signal: AbortSignal.any([controller.signal, context.signal]),
      });
      if (!response.ok) {
        lastMessage = `Webhook answered HTTP ${response.status}.`;
        if (response.status === 429 || response.status >= 500) continue;
        throw new AgentRuntimeError("webhook_http_error", lastMessage, false);
      }
      const text = await readCapped(response, node.data.maxResponseBytes);
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        // Non-JSON responses stay as text.
      }
      const vars: Record<string, unknown> = { [node.data.outputVariable]: parsed };
      for (const mapping of node.data.mappings) {
        vars[mapping.variable] = resolvePath(parsed, mapping.path);
      }
      return { vars, output: parsed, next: "out" };
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      if (context.signal.aborted) {
        throw new AgentRuntimeError("client_closed", "The client closed the connection.", false);
      }
      lastMessage = error instanceof Error ? error.message : "Webhook request failed";
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AgentRuntimeError("webhook_http_error", lastMessage);
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AgentRuntimeError(
        "webhook_response_too_large",
        `Webhook response exceeded the ${maxBytes} byte cap.`,
        false,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function executeMemory(
  node: Extract<FlowNode, { type: "memory" }>,
  state: AgentState,
  context: AgentRunContext,
): Promise<NodeOutcome> {
  const key = render(node.data.key, state, context.inputText).trim();
  if (!key) throw new AgentRuntimeError("memory_invalid_key", "Memory key is empty.");
  const store = context.deps.memory;
  switch (node.data.operation) {
    case "get": {
      const value = state.memory[key];
      return { vars: { [node.data.outputVariable]: value ?? null }, output: value ?? null };
    }
    case "set": {
      const value = render(node.data.value, state, context.inputText);
      await store.set(context.sessionId, key, value);
      return {
        vars: { [node.data.outputVariable]: value },
        memory: { [key]: value },
        output: value,
      };
    }
    case "append": {
      const value = render(node.data.value, state, context.inputText);
      const next = await store.append(context.sessionId, key, value);
      return { vars: { [node.data.outputVariable]: next }, memory: { [key]: next }, output: next };
    }
    case "delete": {
      await store.remove(context.sessionId, key);
      return { vars: { [node.data.outputVariable]: null }, output: null };
    }
  }
}

async function executeMcpTool(
  node: Extract<FlowNode, { type: "mcp_tool" }>,
  state: AgentState,
  context: AgentRunContext,
): Promise<NodeOutcome> {
  const args: Record<string, unknown> = {};
  for (const argument of node.data.args) {
    args[argument.name] = parseArgument(render(argument.value, state, context.inputText));
  }
  let result: { text: string; isError: boolean };
  try {
    result = await context.deps.mcpCall(node.data.serverId, node.data.toolName, args);
  } catch (error) {
    throw new AgentRuntimeError(
      "mcp_call_failed",
      error instanceof Error ? error.message : "MCP call failed",
    );
  }
  if (result.isError) {
    throw new AgentRuntimeError("mcp_tool_error", result.text || "MCP tool returned an error.");
  }
  return {
    vars: { [node.data.outputVariable]: result.text },
    output: result.text,
    next: "out",
  };
}

/**
 * Client Action: emits one fixed Unity tool call and pauses for the result, or (when resumed)
 * stores the result in its variable and follows `error` when the client reported `ok: false`.
 * The calling agent's media/camera restrictions are enforced here too, so they also cover Client
 * Action nodes inside called subflows (where publish-time validation only sees the subflow).
 */
async function executeClientAction(
  node: Extract<FlowNode, { type: "client_action" }>,
  state: AgentState,
  context: AgentRunContext,
): Promise<NodeOutcome> {
  const resuming = state.clientResultsNode === node.id && state.clientResults.length > 0;
  if (resuming) {
    const result = state.clientResults[0];
    const parsed = parseToolResultContent(result.content);
    return {
      vars: { [node.data.outputVariable]: parsed },
      output: parsed,
      next: toolResultFailed(result.content) ? "error" : "out",
      clientResults: [],
      clientResultsNode: "",
    };
  }

  const rendered = renderClientActionArgs(
    node.data.argsTemplate,
    templateScope(state, context.inputText),
  );
  if (!rendered.ok) throw new AgentRuntimeError("client_action_invalid_args", rendered.error);
  const restriction = clientActionProblem(
    node.data.toolName,
    rendered.value,
    context.clientRestrictions ?? UNRESTRICTED,
  );
  if (restriction) throw new AgentRuntimeError("client_action_restricted", restriction);
  const call: ClientToolCall = {
    id: `call_${randomUUID()}`,
    name: node.data.toolName,
    arguments: JSON.stringify(rendered.value),
  };
  return {
    output: { tool: call.name, arguments: rendered.value },
    next: "out",
    pendingClientNode: node.id,
    pendingClientCalls: [call],
  };
}

const MAX_SUBFLOW_DEPTH = 5;

function coerceInput(raw: string, type: SubflowParamType): unknown {
  switch (type) {
    case "number": {
      const value = Number(raw);
      return Number.isFinite(value) ? value : raw;
    }
    case "boolean":
      return raw.trim().toLowerCase() === "true" || raw.trim() === "1";
    case "json": {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    }
    default:
      return raw;
  }
}

async function executeCallSubflow(
  node: Extract<FlowNode, { type: "call_subflow" }>,
  state: AgentState,
  context: AgentRunContext,
): Promise<NodeOutcome> {
  const targetId = node.data.subflowId;
  if (!targetId) {
    throw new AgentRuntimeError("subflow_missing", "Choose a subflow to call.");
  }
  const pinned = context.pinnedSubflows[targetId];
  if (pinned === undefined) {
    throw new AgentRuntimeError(
      "subflow_not_pinned",
      "This subflow has no pinned version; publish the calling flow first.",
    );
  }
  const subflow = await context.deps.loadSubflowVersion(targetId, pinned);
  if (!subflow) {
    throw new AgentRuntimeError(
      "subflow_not_found",
      `Pinned subflow version v${pinned} is not available.`,
    );
  }
  const params = subflowParams(subflow.graph);
  const templates = new Map(node.data.inputs.map((input) => [input.name, input.value]));
  const inputs: Record<string, unknown> = {};
  for (const param of params) {
    const template = templates.get(param.name);
    if (template === undefined) {
      if (param.required) {
        throw new AgentRuntimeError(
          "subflow_input_missing",
          `Missing required input "${param.name}".`,
        );
      }
      continue;
    }
    inputs[param.name] = coerceInput(render(template, state, context.inputText), param.type);
  }
  if (!context.runSubflow) {
    throw new AgentRuntimeError(
      "subflow_runtime_unavailable",
      "Subflow execution is not available in this run.",
    );
  }
  if (context.depth + 1 > MAX_SUBFLOW_DEPTH) {
    throw new AgentRuntimeError(
      "subflow_too_deep",
      `Subflows cannot nest deeper than ${MAX_SUBFLOW_DEPTH} levels.`,
    );
  }
  // A client-tool pause inside the subflow surfaces as a pause of this node: the run stops, the
  // client gets the calls, and the next request delivers the results back through here.
  const resuming = state.clientResultsNode === node.id && state.clientResults.length > 0;
  const result = await context.runSubflow({
    subflow,
    inputs,
    sessionId: context.sessionId,
    memory: state.memory,
    messages: state.messages,
    inputText: context.inputText,
    parent: { flowId: context.flowId, version: context.version, depth: context.depth },
    nodeId: node.id,
    threadId: context.threadId,
    reset: !resuming,
    resume: resuming ? state.clientResults : undefined,
  });
  if (result.paused) {
    return {
      output: { paused: true, calls: result.paused.calls },
      next: "out",
      pendingClientNode: node.id,
      pendingClientCalls: result.paused.calls,
      ...(resuming ? { clientResults: [] as ClientToolResult[], clientResultsNode: "" } : {}),
    };
  }
  const mapping = node.data.outputs.find((output) => output.label === result.label);
  if (!mapping) {
    throw new AgentRuntimeError(
      "subflow_output_unmapped",
      `The subflow returned "${result.label}", which has no output mapping.`,
    );
  }
  const keys = Object.keys(result.values);
  const value = keys.length === 1 ? result.values[keys[0]] : result.values;
  return {
    next: subflowOutputHandle(result.label),
    vars: { [mapping.variable]: value },
    memory: result.memory,
    output: value,
    emittedText: result.text,
    reasoning: result.reasoning,
    usage: result.usage,
    steps: result.steps,
  };
}

async function executeSubflowOutput(
  node: Extract<FlowNode, { type: "subflow_output" }>,
  state: AgentState,
  context: AgentRunContext,
): Promise<NodeOutcome> {
  const values: Record<string, unknown> = {};
  for (const entry of node.data.values) {
    values[entry.name] = render(entry.value, state, context.inputText);
  }
  return {
    next: "out",
    output: values,
    subflowOutput: { label: node.data.label, values },
  };
}

async function executeReply(
  node: Extract<FlowNode, { type: "reply" }>,
  state: AgentState,
  context: AgentRunContext,
): Promise<NodeOutcome> {
  const text = render(node.data.template, state, context.inputText);
  context.emitText(text);
  return { emittedText: text, output: text, next: "out" };
}

/** Runs one node and returns its state updates; throws `AgentRuntimeError` on a fallible failure. */
export async function executeNode(
  node: FlowNode,
  state: AgentState,
  context: AgentRunContext,
): Promise<NodeOutcome> {
  switch (node.type) {
    case "start":
      return { next: "out" };
    case "llm":
      return executeLlm(node, state, context);
    case "router":
      return executeRouter(node, state, context);
    case "set_variable":
      return executeSetVariable(node, state, context);
    case "webhook":
      return executeWebhook(node, state, context);
    case "memory":
      return executeMemory(node, state, context);
    case "mcp_tool":
      return executeMcpTool(node, state, context);
    case "client_action":
      return executeClientAction(node, state, context);
    case "reply":
      return executeReply(node, state, context);
    case "end":
      return { next: "out" };
    case "subflow_input":
      return { next: "out" };
    case "subflow_output":
      return executeSubflowOutput(node, state, context);
    case "call_subflow":
      return executeCallSubflow(node, state, context);
    case "note":
    case "group":
      // Canvas-only nodes never reach the runtime; the compiler filters them out.
      return { next: "out" };
  }
}

/** Resolves the next node from an output handle, or `undefined` when the path ends. */
export function resolveTarget(
  graph: FlowGraph,
  sourceId: string,
  cursor: string,
): string | undefined {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const candidates = graph.edges.filter((edge) => edge.source === sourceId);
  const exact = candidates.find((edge) => (edge.sourceHandle ?? "out") === cursor);
  if (exact) return nodeIds.has(exact.target) ? exact.target : undefined;
  if (cursor === "out") {
    const fallback = candidates.find(
      (edge) => edge.sourceHandle === null || edge.sourceHandle === undefined,
    );
    if (fallback) return nodeIds.has(fallback.target) ? fallback.target : undefined;
  }
  return undefined;
}

/** An error with no connected `error` handle ends the run as failed. */
export function errorHasRoute(graph: FlowGraph, nodeId: string): boolean {
  return graph.edges.some(
    (edge) => edge.source === nodeId && (edge.sourceHandle ?? "out") === "error",
  );
}

/** LLM nodes with no Reply downstream stream straight to the client when marked `stream`. */
export function computeTerminalLlmNodes(graph: FlowGraph): Set<string> {
  const result = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type !== "llm") continue;
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const handle of nodeHandles(node)) {
      if (handle.kind === "error") continue;
      const target = resolveTarget(graph, node.id, handle.id);
      if (target) queue.push(target);
    }
    let hasReply = false;
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const candidate = graph.nodes.find((entry) => entry.id === id);
      if (!candidate) continue;
      if (candidate.type === "reply") {
        hasReply = true;
        break;
      }
      for (const handle of nodeHandles(candidate)) {
        if (handle.kind === "error") continue;
        const target = resolveTarget(graph, candidate.id, handle.id);
        if (target) queue.push(target);
      }
    }
    if (!hasReply) result.add(node.id);
  }
  return result;
}

export { isFallibleNode };

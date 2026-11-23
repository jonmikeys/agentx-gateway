import { type FlowGraph, type FlowNode, isFallibleNode, nodeHandles } from "@/lib/agents/graph";
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
  fetchImpl?: typeof fetch;
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
  emitText: (delta: string) => void;
  /** Live node lifecycle events for the CRM test drawer and streaming callers. */
  onNodeStart?: (node: FlowNode) => void;
  onNodeEnd?: (step: RunTraceStep) => void;
  signal: AbortSignal;
}

export interface NodeOutcome {
  /** Handle id to follow; defaults to `out`. */
  next?: string;
  vars?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  output?: unknown;
  /** Text emitted to the client this node; appended to the run reply. */
  emittedText?: string;
  reasoning?: string;
  usage?: TokenUsage;
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
  const tools = await context.deps.mcpToolsByIds(node.data.mcpToolIds);
  const streaming = tools.length === 0 && node.data.stream && context.terminalLlmNodes.has(node.id);
  let messages = historyMessages(state, node, context);
  let usageText = "";
  let reasoning = "";
  let usage: TokenUsage | undefined;
  const toolsByName = new Map(tools.map((tool) => [tool.exposedName, tool]));

  const rounds = tools.length > 0 ? 4 : 1;
  for (let round = 0; round < rounds; round += 1) {
    const isLast = round === rounds - 1;
    const result = await chatThroughRoute({
      route,
      messages,
      tools: tools.length > 0 ? toolDefinitions(tools) : undefined,
      toolChoice: tools.length > 0 ? (isLast ? "none" : "auto") : undefined,
      stream: streaming,
      signal: context.signal,
      fetchImpl: context.deps.fetchImpl,
      onDelta: streaming ? (delta) => delta.text && context.emitText(delta.text) : undefined,
    });
    reasoning += result.reasoning;
    usage = addUsage(usage, result.usage);
    usageText = result.text;
    const calls = result.toolCalls.filter((call) => call.name && toolsByName.has(call.name));
    if (calls.length === 0 || tools.length === 0 || isLast) break;

    const assistantCalls = calls.map((call, index) => ({
      id: call.id ?? `call_${round}_${index}`,
      type: "function",
      function: { name: call.name ?? "", arguments: call.rawArguments || "{}" },
    }));
    const toolMessages: unknown[] = [];
    for (const [index, call] of calls.entries()) {
      const tool = call.name ? toolsByName.get(call.name) : undefined;
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
      toolMessages.push({
        role: "tool",
        tool_call_id: assistantCalls[index]?.id ?? `call_${round}_${index}`,
        content,
      });
    }
    messages = [
      ...messages,
      { role: "assistant", content: result.text || null, tool_calls: assistantCalls },
      ...toolMessages,
    ];
  }

  const emitted = streaming ? usageText : undefined;
  return {
    vars: { [node.data.outputVariable]: usageText },
    output: usageText,
    emittedText: emitted,
    reasoning,
    usage,
    next: "out",
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
    case "reply":
      return executeReply(node, state, context);
    case "end":
      return { next: "out" };
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

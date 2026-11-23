import { Annotation, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import type { ClientToolCall, ClientToolResult } from "@/lib/agents/client-tools";
import type { FlowGraph, FlowNode } from "@/lib/agents/graph";
import type { RunTraceStep } from "@/lib/agents/types";
import { getCheckpointer } from "@/server/agents/checkpointer";
import { AgentRuntimeError } from "@/server/agents/llm";
import {
  type AgentRunContext,
  type AgentState,
  addUsage,
  errorHasRoute,
  executeNode,
  resolveTarget,
} from "@/server/agents/nodes";
import type { TokenUsage } from "@/server/db/schema";

/** LangGraph state: one channel per spec §13 field plus run bookkeeping. */
const AgentAnnotation = Annotation.Root({
  messages: Annotation<unknown[]>({ reducer: (_previous, next) => next, default: () => [] }),
  sessionId: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
  vars: Annotation<Record<string, unknown>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
  memory: Annotation<Record<string, unknown>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
  output: Annotation<unknown>({ reducer: (_previous, next) => next, default: () => null }),
  cursor: Annotation<string>({ reducer: (_previous, next) => next, default: () => "out" }),
  trace: Annotation<RunTraceStep[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  text: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
  reasoning: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
  usage: Annotation<TokenUsage | undefined>({
    reducer: (_previous, next) => next,
    default: () => undefined,
  }),
  lastError: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
  fatal: Annotation<boolean>({ reducer: (_previous, next) => next, default: () => false }),
  failedNodeId: Annotation<string | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  /** Client tool calls awaiting the client; the wait node interrupts and resumes here. */
  pendingClientNode: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
  pendingClientCalls: Annotation<ClientToolCall[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  clientResults: Annotation<ClientToolResult[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  clientResultsNode: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
});

type AgentChannels = typeof AgentAnnotation.State;

/** Structural view of the checkpoint snapshot the runtime reads after a run. */
export interface AgentSnapshot {
  next: string[];
  tasks: { interrupts: { value?: unknown }[] }[];
}

/** Minimal executor surface used by the runtime (keeps LangGraph's generic types contained). */
export interface CompiledAgent {
  invoke(input: Partial<AgentChannels>, config?: unknown): Promise<AgentChannels>;
  getState(config?: unknown): Promise<AgentSnapshot>;
}

const MAX_STRING = 4000;

function clipValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => clipValue(entry, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = clipValue(entry, depth + 1);
  return result;
}

function contextOf(config: unknown): AgentRunContext {
  const context = (config as { configurable?: { agentContext?: AgentRunContext } })?.configurable
    ?.agentContext;
  if (!context) throw new Error("Agent run context is missing");
  return context;
}

function nodeRunner(node: FlowNode) {
  return async (state: AgentChannels, config: unknown): Promise<Partial<AgentChannels>> => {
    const context = contextOf(config);
    const startedAt = new Date();
    const startedMs = performance.now();
    context.onNodeStart?.(node);
    const input = clipValue({
      input: context.inputText,
      vars: state.vars,
      memory: state.memory,
      node: node.data,
    });

    try {
      const outcome = await executeNode(node, state as AgentState, context);
      const durationMs = Math.round(performance.now() - startedMs);
      const step: RunTraceStep = {
        node_id: node.id,
        node_type: node.type,
        title: node.data.title,
        status: "ok",
        started_at: startedAt.toISOString(),
        duration_ms: durationMs,
        input,
        output: clipValue({
          handle: outcome.next ?? "out",
          vars: outcome.vars,
          output: outcome.output,
        }),
      };
      context.onNodeEnd?.(step);
      return {
        vars: { ...state.vars, ...(outcome.vars ?? {}) },
        memory: { ...state.memory, ...(outcome.memory ?? {}) },
        output: outcome.output ?? null,
        cursor: outcome.next ?? "out",
        trace: [...state.trace, step],
        text: outcome.emittedText ? state.text + outcome.emittedText : state.text,
        reasoning: outcome.reasoning ? state.reasoning + outcome.reasoning : state.reasoning,
        usage: addUsage(state.usage, outcome.usage),
        lastError: "",
        ...(outcome.messages !== undefined ? { messages: outcome.messages } : {}),
        ...(outcome.pendingClientNode !== undefined
          ? { pendingClientNode: outcome.pendingClientNode }
          : {}),
        ...(outcome.pendingClientCalls !== undefined
          ? { pendingClientCalls: outcome.pendingClientCalls }
          : {}),
        ...(outcome.clientResults !== undefined ? { clientResults: outcome.clientResults } : {}),
        ...(outcome.clientResultsNode !== undefined
          ? { clientResultsNode: outcome.clientResultsNode }
          : {}),
      };
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedMs);
      const code = error instanceof AgentRuntimeError ? error.code : "node_error";
      const message = error instanceof Error ? error.message : "Node failed";
      const fatal = !errorHasRoute(context.graph, node.id);
      const step: RunTraceStep = {
        node_id: node.id,
        node_type: node.type,
        title: node.data.title,
        status: "error",
        started_at: startedAt.toISOString(),
        duration_ms: durationMs,
        input,
        error: `${code}: ${message}`,
      };
      context.onNodeEnd?.(step);
      return {
        cursor: "error",
        trace: [...state.trace, step],
        lastError: `${code}: ${message}`,
        fatal: state.fatal || fatal,
        failedNodeId: fatal ? node.id : state.failedNodeId,
      };
    }
  };
}

/** Resume payloads may be shaped as `{toolCallId, content}` or `{tool_call_id, content}`. */
function normalizeResumeResults(value: unknown): ClientToolResult[] {
  const list = Array.isArray(value) ? value : [];
  const results: ClientToolResult[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id =
      typeof record.toolCallId === "string"
        ? record.toolCallId
        : typeof record.tool_call_id === "string"
          ? record.tool_call_id
          : undefined;
    if (!id) continue;
    const content =
      typeof record.content === "string" ? record.content : JSON.stringify(record.content ?? null);
    results.push({ toolCallId: id, content });
  }
  return results;
}

/**
 * The client-tool wait node: interrupts the run (checkpointed) and, once the next request
 * delivers the results, hands them back to the originating node. It never calls a model, so
 * resuming is cheap and idempotent.
 */
function waitRunner(node: FlowNode) {
  return async (state: AgentChannels, config: unknown): Promise<Partial<AgentChannels>> => {
    const context = contextOf(config);
    const startedAt = new Date().toISOString();
    const resumed = interrupt({
      kind: "client_tools",
      nodeId: node.id,
      calls: state.pendingClientCalls,
    });
    const results = normalizeResumeResults(resumed);
    const step: RunTraceStep = {
      node_id: node.id,
      node_type: "client_wait",
      title: "Resumed",
      status: "ok",
      started_at: startedAt,
      duration_ms: 0,
      output: { tool_results: results },
    };
    context.onNodeEnd?.(step);
    return {
      clientResults: results,
      clientResultsNode: node.id,
      pendingClientNode: "",
      pendingClientCalls: [],
      trace: [...state.trace, step],
    };
  };
}

function buildGraph(graph: FlowGraph) {
  // The generic StateGraph type narrows node names to the literals it knows at build time; every
  // agent graph has dynamic node ids, so use a small structural view of the builder.
  const builder = new StateGraph(AgentAnnotation) as unknown as {
    addNode(
      name: string,
      fn: (state: AgentChannels, config: unknown) => Promise<Partial<AgentChannels>>,
    ): void;
    addEdge(from: string, to: string): void;
    addConditionalEdges(from: string, fn: (state: AgentChannels) => string): void;
    compile(options?: { checkpointer?: unknown }): CompiledAgent;
  };
  const start = graph.nodes.find((node) => node.type === "start");
  if (!start) throw new AgentRuntimeError("flow_invalid", "The chatflow has no Start node.");
  // Node ids are user data and may collide with LangGraph state channel names (for example a
  // node called "memory"); prefix every graph node name and map targets back through it.
  const nameOf = (id: string) => `node_${id}`;
  const waitNameOf = (id: string) => `wait_${id}`;
  const usesClientTools = (node: FlowNode) => node.type === "llm" || node.type === "client_action";

  for (const node of graph.nodes) {
    builder.addNode(nameOf(node.id), nodeRunner(node));
    if (!usesClientTools(node)) continue;
    // Pause here when the node produced client tool calls, then loop back to consume the results.
    builder.addNode(waitNameOf(node.id), waitRunner(node));
    builder.addEdge(waitNameOf(node.id), nameOf(node.id));
  }
  builder.addEdge(START, nameOf(start.id));

  for (const node of graph.nodes) {
    if (node.type === "end") {
      builder.addEdge(nameOf(node.id), END);
      continue;
    }
    builder.addConditionalEdges(nameOf(node.id), (state) => {
      if (usesClientTools(node) && state.pendingClientNode === node.id) {
        return waitNameOf(node.id);
      }
      const target = resolveTarget(graph, node.id, state.cursor);
      return target ? nameOf(target) : END;
    });
  }
  return builder;
}

const cache = new Map<string, CompiledAgent>();

export function clearCompiledGraphCache(): void {
  cache.clear();
}

/**
 * Compiles a published graph to a LangGraph StateGraph, cached per flow version. The checkpointer
 * persists every run under `thread_id = session id`, so a client-tool interrupt can be resumed.
 * Tests may pass their own in-memory checkpointer (bypassing the cache).
 */
export async function compileAgentGraph(
  flowId: string,
  version: number,
  graph: FlowGraph,
  injectedCheckpointer?: unknown,
): Promise<CompiledAgent> {
  const key = `${flowId}@${version}`;
  if (!injectedCheckpointer) {
    const cached = cache.get(key);
    if (cached) return cached;
  }

  const checkpointer = injectedCheckpointer ?? (await getCheckpointer());
  const builder = buildGraph(graph);
  const compiled = (checkpointer
    ? builder.compile({ checkpointer })
    : builder.compile()) as unknown as CompiledAgent;
  if (!injectedCheckpointer) cache.set(key, compiled);
  return compiled;
}

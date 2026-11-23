import { randomUUID } from "node:crypto";
import type { FlowGraph } from "@/lib/agents/graph";
import type { AgentRuntimeEvent, RunTrace, RunTraceStep } from "@/lib/agents/types";
import { compileAgentGraph, compileSubflowGraph } from "@/server/agents/compiler";
import { withAgentDependencies } from "@/server/agents/deps";
import { AgentRuntimeError } from "@/server/agents/llm";
import {
  type AgentDependencies,
  type AgentRunContext,
  computeTerminalLlmNodes,
  type SubflowRunRequest,
  type SubflowRunResult,
} from "@/server/agents/nodes";
import type { TokenUsage } from "@/server/db/schema";
import { logger } from "@/server/logger";
import type { ResolvedRoute } from "@/server/services/routes";

export interface RunAgentOptions {
  flowId: string;
  version: number;
  graph: FlowGraph;
  sessionId: string;
  /** Chat-format conversation from the request (the client sends full history). */
  messages: unknown[];
  /** Latest user text, exposed to templates as `{{input.text}}`. */
  inputText: string;
  /** Route used by `inherit` nodes (the request route or the agent default route). */
  route: ResolvedRoute | undefined;
  signal: AbortSignal;
  /** Subflow pins of the running version; the top-level agent passes its published pins. */
  pinnedSubflows?: Record<string, number>;
  deps?: Partial<AgentDependencies>;
  /** Live events for streaming adapters and the CRM test drawer. */
  onEvent?: (event: AgentRuntimeEvent) => void;
}

export interface RunAgentResult {
  reply: string;
  reasoning: string;
  status: "ok" | "error";
  error?: string;
  trace: RunTrace;
  usage?: TokenUsage;
}

function emptyTrace(flowId: string, version: number, startedAt: Date, message: string): RunTrace {
  return {
    run_id: randomUUID(),
    flow_id: flowId,
    version,
    status: "error",
    started_at: startedAt.toISOString(),
    duration_ms: 0,
    steps: [],
    error: message,
  };
}

/**
 * Runs one published agent graph for a request: loads session memory, invokes the compiled
 * LangGraph graph (checkpointed by session), streams text as nodes produce it and records the
 * per-node trace. Never throws for a node failure; the trace carries it.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const deps = withAgentDependencies(options.deps);
  const startedAt = new Date();
  const startedMs = performance.now();
  const emit = (event: AgentRuntimeEvent) => {
    try {
      options.onEvent?.(event);
    } catch (error) {
      logger.warn("Agent event listener failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  };

  const streamText = (delta: string) => {
    if (delta) emit({ type: "text", delta });
  };

  /**
   * Executes a pinned subflow as a nested LangGraph graph. It gets its own vars (the mapped
   * inputs), shares the session memory and conversation, streams its Replies to the client and
   * returns its trace so the call step can nest it. Client-tool interrupts raised inside it
   * propagate to the parent run.
   */
  const runNested = async (request: SubflowRunRequest): Promise<SubflowRunResult> => {
    const { subflow } = request;
    const compiled = await compileSubflowGraph(subflow.flowId, subflow.version, subflow.graph);
    const subContext: AgentRunContext = {
      flowId: subflow.flowId,
      version: subflow.version,
      sessionId: request.sessionId,
      graph: subflow.graph,
      inputText: request.inputText,
      terminalLlmNodes: computeTerminalLlmNodes(subflow.graph),
      route: options.route,
      deps,
      emitText: streamText,
      signal: options.signal,
      pinnedSubflows: subflow.pinnedSubflows,
      depth: request.parent.depth + 1,
      runSubflow: runNested,
    };
    const final = await compiled.invoke(
      {
        messages: request.messages,
        sessionId: request.sessionId,
        vars: request.inputs,
        memory: request.memory,
        output: null,
        cursor: "out",
        trace: [],
        text: "",
        reasoning: "",
        usage: undefined,
        lastError: "",
        fatal: false,
        failedNodeId: null,
        outputLabel: "",
        subflowOutput: {},
      },
      {
        recursionLimit: 50,
        configurable: { thread_id: request.sessionId, agentContext: subContext },
      },
    );
    if (final.fatal) {
      throw new AgentRuntimeError("subflow_failed", final.lastError || "The subflow run failed.");
    }
    return {
      label: final.outputLabel ?? "",
      values: final.subflowOutput ?? {},
      memory: final.memory,
      text: final.text,
      reasoning: final.reasoning,
      usage: final.usage,
      steps: final.trace as RunTraceStep[],
    };
  };

  try {
    const memory = await deps.memory.load(options.sessionId);
    const context: AgentRunContext = {
      flowId: options.flowId,
      version: options.version,
      sessionId: options.sessionId,
      graph: options.graph,
      inputText: options.inputText,
      terminalLlmNodes: computeTerminalLlmNodes(options.graph),
      route: options.route,
      deps,
      emitText: streamText,
      onNodeStart: (node) =>
        emit({ type: "node_start", nodeId: node.id, nodeType: node.type, title: node.data.title }),
      onNodeEnd: (step) =>
        emit({
          type: "node_end",
          nodeId: step.node_id,
          status: step.status,
          durationMs: step.duration_ms,
          error: step.error,
        }),
      signal: options.signal,
      pinnedSubflows: options.pinnedSubflows ?? {},
      depth: 0,
      runSubflow: runNested,
    };

    const compiled = await compileAgentGraph(options.flowId, options.version, options.graph);
    const final = await compiled.invoke(
      {
        messages: options.messages,
        sessionId: options.sessionId,
        vars: {},
        memory,
        output: null,
        cursor: "out",
        trace: [],
        text: "",
        reasoning: "",
        usage: undefined,
        lastError: "",
        fatal: false,
        failedNodeId: null,
        outputLabel: "",
        subflowOutput: {},
      },
      {
        recursionLimit: 50,
        configurable: { thread_id: options.sessionId, agentContext: context },
      },
    );

    const durationMs = Math.round(performance.now() - startedMs);
    const status: "ok" | "error" = final.fatal ? "error" : "ok";
    const trace: RunTrace = {
      run_id: randomUUID(),
      flow_id: options.flowId,
      version: options.version,
      status,
      started_at: startedAt.toISOString(),
      duration_ms: durationMs,
      steps: final.trace as RunTraceStep[],
      error: final.lastError || undefined,
      failed_node_id: final.failedNodeId,
    };
    const result: RunAgentResult = {
      reply: final.text.trim(),
      reasoning: final.reasoning.trim(),
      status,
      error: status === "error" ? final.lastError || "The agent run failed." : undefined,
      trace,
      usage: final.usage,
    };
    emit({ type: "done", reply: result.reply, trace });
    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedMs);
    const code = error instanceof AgentRuntimeError ? error.code : "agent_run_failed";
    const message = error instanceof Error ? error.message : "The agent run failed.";
    const trace = emptyTrace(options.flowId, options.version, startedAt, `${code}: ${message}`);
    trace.duration_ms = durationMs;
    emit({ type: "done", reply: "", trace });
    return { reply: "", reasoning: "", status: "error", error: `${code}: ${message}`, trace };
  }
}

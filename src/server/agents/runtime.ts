import { randomUUID } from "node:crypto";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { Command, isGraphInterrupt } from "@langchain/langgraph";
import type {
  ClientToolCall,
  ClientToolDefinition,
  ClientToolRestrictions,
  ClientToolResult,
} from "@/lib/agents/client-tools";
import type { FlowGraph } from "@/lib/agents/graph";
import type { AgentRuntimeEvent, RunTrace, RunTraceStep } from "@/lib/agents/types";
import { getCheckpointer } from "@/server/agents/checkpointer";
import {
  type AgentSnapshot,
  type CompiledAgent,
  compileAgentGraph,
  compileSubflowGraph,
} from "@/server/agents/compiler";
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
import { parseToolArguments } from "@/server/gateway/transcript/diff";
import type { CapturedToolCall } from "@/server/gateway/transcript/response-capture";
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
  /** Function tools the client sent with the request (offered by LLM nodes that select them). */
  clientTools?: ClientToolDefinition[];
  /** Resolved media/camera allow-lists that narrow the forwarded catalogue tools. */
  clientRestrictions?: ClientToolRestrictions;
  /** Test seam: an in-memory checkpointer instead of the Postgres one. */
  checkpointer?: unknown;
  /** Live events for streaming adapters and the CRM test drawer. */
  onEvent?: (event: AgentRuntimeEvent) => void;
}

export interface RunAgentResult {
  reply: string;
  reasoning: string;
  status: "ok" | "error" | "paused";
  error?: string;
  trace: RunTrace;
  usage?: TokenUsage;
  /** Client tool calls the gateway returned when the run paused. */
  toolCalls?: CapturedToolCall[];
}

interface ClientToolInterrupt {
  kind: "client_tools";
  nodeId: string;
  calls: ClientToolCall[];
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

function interruptsOf(snapshot: AgentSnapshot | undefined): ClientToolInterrupt[] {
  if (!snapshot) return [];
  const found: ClientToolInterrupt[] = [];
  for (const task of snapshot.tasks) {
    for (const entry of task.interrupts) {
      const value = entry.value as Partial<ClientToolInterrupt> | undefined;
      if (value?.kind === "client_tools" && Array.isArray(value.calls)) {
        found.push(value as ClientToolInterrupt);
      }
    }
  }
  return found;
}

function lastRole(messages: unknown[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (typeof message !== "object" || message === null) continue;
    const role = (message as { role?: unknown }).role;
    if (typeof role === "string") return role;
  }
  return undefined;
}

/** Tool results for the paused call ids, when the request carries all of them and no new user turn. */
function resumeResults(
  messages: unknown[],
  calls: ClientToolCall[],
): ClientToolResult[] | undefined {
  if (calls.length === 0) return undefined;
  if (lastRole(messages) === "user") return undefined;
  const results: ClientToolResult[] = [];
  for (const call of calls) {
    const message = [...messages]
      .reverse()
      .find(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { role?: unknown }).role === "tool" &&
          (entry as { tool_call_id?: unknown }).tool_call_id === call.id,
      ) as { content?: unknown } | undefined;
    if (!message) return undefined;
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? null);
    results.push({ toolCallId: call.id, content });
  }
  return results;
}

function pausedStep(pending: ClientToolInterrupt): RunTraceStep {
  return {
    node_id: pending.nodeId,
    node_type: "client_wait",
    title: "Paused (waiting for client)",
    status: "skipped",
    started_at: new Date().toISOString(),
    duration_ms: 0,
    output: { calls: pending.calls },
  };
}

function toCapturedCalls(calls: ClientToolCall[]): CapturedToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    args: parseToolArguments(call.arguments),
    rawArguments: call.arguments,
  }));
}

/** Empty initial channel values for one graph thread (both agent and subflow channels). */
function initialState(
  options: {
    messages: unknown[];
    sessionId: string;
    vars: Record<string, unknown>;
    memory: Record<string, unknown>;
  },
  trace: RunTraceStep[] = [],
): Record<string, unknown> {
  return {
    messages: options.messages,
    sessionId: options.sessionId,
    vars: options.vars,
    memory: options.memory,
    output: null,
    cursor: "out",
    trace,
    text: "",
    reasoning: "",
    usage: undefined,
    lastError: "",
    fatal: false,
    failedNodeId: null,
    pendingClientNode: "",
    pendingClientCalls: [] as ClientToolCall[],
    clientResults: [] as ClientToolResult[],
    clientResultsNode: "",
    outputLabel: "",
    subflowOutput: {},
  };
}

/**
 * Runs one published agent graph for a request: loads session memory, invokes the compiled
 * LangGraph graph (checkpointed by session), streams text as nodes produce it and records the
 * per-node trace. A run that asks for client tools pauses; the next request that carries their
 * results resumes the same checkpoint. Never throws for a node failure; the trace carries it.
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
   * Executes a pinned subflow as a nested LangGraph graph under its own child checkpoint thread.
   * It gets its own vars (the mapped inputs), shares the session memory/conversation, streams its
   * Replies to the client and returns its trace so the call step can nest it. A client-tool
   * interrupt raised inside it pauses the whole run: the subflow checkpoint is kept, the parent
   * pauses on its Call Subflow wait node, and the next request resumes the subflow here.
   */
  const runNested = async (request: SubflowRunRequest): Promise<SubflowRunResult> => {
    const { subflow } = request;
    const compiled = await compileSubflowGraph(
      subflow.flowId,
      subflow.version,
      subflow.graph,
      options.checkpointer,
    );
    const threadId = `${request.threadId}/${request.nodeId}`;
    const subContext: AgentRunContext = {
      flowId: subflow.flowId,
      version: subflow.version,
      sessionId: request.sessionId,
      graph: subflow.graph,
      inputText: request.inputText,
      terminalLlmNodes: computeTerminalLlmNodes(subflow.graph),
      route: options.route,
      deps,
      clientTools: options.clientTools ?? [],
      clientRestrictions: options.clientRestrictions,
      emitText: streamText,
      signal: options.signal,
      threadId,
      pinnedSubflows: subflow.pinnedSubflows,
      depth: request.parent.depth + 1,
      runSubflow: runNested,
    };
    const config = {
      recursionLimit: 50,
      configurable: { thread_id: threadId, agentContext: subContext },
    };
    // A fresh call site must not inherit a leftover paused checkpoint from an abandoned run.
    if (request.reset) await deleteThread(options.checkpointer, threadId);

    let input: unknown = initialState({
      messages: request.messages,
      sessionId: request.sessionId,
      vars: request.inputs,
      memory: request.memory,
    });
    // Run the subflow as its own top-level graph. Without this, LangGraph would see the caller's
    // ambient `__pregel_read` config and treat the subflow as a *nested* run, where an interrupt is
    // rethrown (and checkpointed under an ephemeral namespace) instead of pausing this child thread.
    const isolated = <T>(fn: () => Promise<T>) =>
      AsyncLocalStorageProviderSingleton.runWithConfig({}, fn);
    if (request.resume && request.resume.length > 0) {
      const pausedBefore = await isolated(() => readSnapshot(compiled, config));
      if (pausedBefore && pausedBefore.next.length > 0 && interruptsOf(pausedBefore).length > 0) {
        input = new Command({ resume: request.resume });
      }
    }
    let final: Record<string, unknown>;
    try {
      final = (await isolated(() =>
        compiled.invoke(input as Partial<Record<string, unknown>>, config),
      )) as Record<string, unknown>;
    } catch (error) {
      // Defensive: if an interrupt still surfaces as an exception, keep the checkpoint and pause.
      const thrown = interruptFromError(error);
      const snapshot = thrown ? await isolated(() => readSnapshot(compiled, config)) : undefined;
      const pending = interruptsOf(snapshot)[0] ?? thrown;
      if (!pending) throw error;
      return {
        label: "",
        values: {},
        memory: (snapshot?.values?.memory as Record<string, unknown>) ?? {},
        text: "",
        reasoning: "",
        steps: [],
        paused: { calls: pending.calls },
      };
    }

    const snapshot = await isolated(() => readSnapshot(compiled, config));
    const pending = interruptsOf(snapshot)[0] ?? interruptFromFinal(final);
    if (pending) {
      return {
        label: "",
        values: {},
        memory: (final.memory as Record<string, unknown>) ?? {},
        text: typeof final.text === "string" ? final.text : "",
        reasoning: typeof final.reasoning === "string" ? final.reasoning : "",
        usage: final.usage as TokenUsage | undefined,
        steps: (final.trace as RunTraceStep[] | undefined) ?? [],
        paused: { calls: pending.calls },
      };
    }
    if (final.fatal) {
      await deleteThread(options.checkpointer, threadId);
      throw new AgentRuntimeError(
        "subflow_failed",
        (final.lastError as string) || "The subflow run failed.",
      );
    }
    await deleteThread(options.checkpointer, threadId);
    return {
      label: (final.outputLabel as string) ?? "",
      values: (final.subflowOutput as Record<string, unknown>) ?? {},
      memory: final.memory as Record<string, unknown>,
      text: (final.text as string) ?? "",
      reasoning: (final.reasoning as string) ?? "",
      usage: final.usage as TokenUsage | undefined,
      steps: (final.trace as RunTraceStep[] | undefined) ?? [],
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
      clientTools: options.clientTools ?? [],
      clientRestrictions: options.clientRestrictions,
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
      threadId: options.sessionId,
      pinnedSubflows: options.pinnedSubflows ?? {},
      depth: 0,
      runSubflow: runNested,
    };

    const compiled = await compileAgentGraph(
      options.flowId,
      options.version,
      options.graph,
      options.checkpointer,
    );
    const config = {
      recursionLimit: 50,
      configurable: { thread_id: options.sessionId, agentContext: context },
    };
    const initial = initialState({
      messages: options.messages,
      sessionId: options.sessionId,
      vars: {},
      memory,
    });

    let input: unknown = initial;
    const pausedBefore = await readSnapshot(compiled, config);
    const pendingBefore = interruptsOf(pausedBefore)[0];
    if (pausedBefore && pausedBefore.next.length > 0 && pendingBefore) {
      const results = resumeResults(options.messages, pendingBefore.calls);
      if (results) {
        input = new Command({ resume: results });
      } else {
        // A new user message (or a request without the results) abandons the paused run.
        await deleteThread(options.checkpointer, options.sessionId);
        logger.info("Agent paused run abandoned", {
          flow: options.flowId,
          session: options.sessionId,
        });
      }
    }

    const final = (await compiled.invoke(
      input as Partial<Record<string, unknown>>,
      config,
    )) as Record<string, unknown>;

    const snapshot = await readSnapshot(compiled, config);
    const pending = interruptsOf(snapshot)[0] ?? interruptFromFinal(final);
    const durationMs = Math.round(performance.now() - startedMs);

    if (pending) {
      const trace: RunTrace = {
        run_id: randomUUID(),
        flow_id: options.flowId,
        version: options.version,
        status: "ok",
        started_at: startedAt.toISOString(),
        duration_ms: durationMs,
        steps: [...((final.trace as RunTraceStep[] | undefined) ?? []), pausedStep(pending)],
        paused: true,
      };
      const result: RunAgentResult = {
        reply: typeof final.text === "string" ? final.text.trim() : "",
        reasoning: typeof final.reasoning === "string" ? final.reasoning.trim() : "",
        status: "paused",
        trace,
        usage: final.usage as TokenUsage | undefined,
        toolCalls: toCapturedCalls(pending.calls),
      };
      emit({ type: "done", reply: result.reply, trace });
      return result;
    }

    const status: "ok" | "error" = final.fatal ? "error" : "ok";
    const trace: RunTrace = {
      run_id: randomUUID(),
      flow_id: options.flowId,
      version: options.version,
      status,
      started_at: startedAt.toISOString(),
      duration_ms: durationMs,
      steps: (final.trace as RunTraceStep[]) ?? [],
      error: (final.lastError as string) || undefined,
      failed_node_id: (final.failedNodeId as string | null) ?? undefined,
    };
    const result: RunAgentResult = {
      reply: typeof final.text === "string" ? final.text.trim() : "",
      reasoning: typeof final.reasoning === "string" ? final.reasoning.trim() : "",
      status,
      error:
        status === "error" ? (final.lastError as string) || "The agent run failed." : undefined,
      trace,
      usage: final.usage as TokenUsage | undefined,
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

async function readSnapshot(
  compiled: CompiledAgent,
  config: unknown,
): Promise<AgentSnapshot | undefined> {
  try {
    return await compiled.getState(config);
  } catch {
    return undefined;
  }
}

/** The invoke result carries `__interrupt__` when the run paused (also without a checkpointer). */
function interruptFromFinal(final: Record<string, unknown>): ClientToolInterrupt | undefined {
  const raw = final.__interrupt__;
  if (!Array.isArray(raw)) return undefined;
  for (const entry of raw) {
    const value = (entry as { value?: unknown })?.value as Partial<ClientToolInterrupt> | undefined;
    if (value?.kind === "client_tools" && Array.isArray(value.calls)) {
      return value as ClientToolInterrupt;
    }
  }
  return undefined;
}

/** A nested graph rethrows its interrupt; pull the client-tool pause out of it. */
function interruptFromError(error: unknown): ClientToolInterrupt | undefined {
  if (!isGraphInterrupt(error)) return undefined;
  const entries = (error as { interrupts?: { value?: unknown }[] }).interrupts ?? [];
  for (const entry of entries) {
    const value = entry.value as Partial<ClientToolInterrupt> | undefined;
    if (value?.kind === "client_tools" && Array.isArray(value.calls)) {
      return value as ClientToolInterrupt;
    }
  }
  return undefined;
}

async function deleteThread(injected: unknown, threadId: string): Promise<void> {
  const saver = (injected ?? (await getCheckpointer())) as
    | { deleteThread?: (threadId: string) => Promise<void> }
    | undefined;
  if (saver?.deleteThread) await saver.deleteThread(threadId);
}

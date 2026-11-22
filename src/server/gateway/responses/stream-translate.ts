import type { TokenUsage } from "@/server/db/schema";
import {
  buildResponseObject,
  functionCallItem,
  incompleteReason,
  type Json,
  messageItem,
  newId,
  outputTextPart,
  type ResponseStatus,
  reasoningItem,
} from "@/server/gateway/responses/response-objects";
import { ThinkTagSplitter } from "@/server/gateway/transcript/think-splitter";
import { extractUsage } from "@/server/gateway/usage";

/** One Responses SSE event: `event: <type>` plus the JSON payload (which repeats `type`). */
export interface ResponseEvent {
  type: string;
  data: Json;
}

interface ToolState {
  itemId: string;
  callId: string;
  name: string;
  args: string;
  outputIndex: number;
  /** `output_item.added` was sent (it waits for the function name). */
  announced: boolean;
  pendingDelta: string;
  closed: boolean;
}

type OpenItem =
  | { kind: "reasoning"; itemId: string; outputIndex: number; text: string }
  | { kind: "message"; itemId: string; outputIndex: number; text: string }
  | { kind: "tool"; tool: ToolState };

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/**
 * Converts a Chat Completions chunk stream into spec-shaped Responses events. One output item is
 * open at a time: when the model switches from reasoning to text to a tool call, the previous item
 * is closed first. Input is already-parsed chunk objects, so chunk splitting is the SSE parser's
 * concern; this class only sees whole chunks.
 */
export class ChatToResponsesStream {
  readonly responseId = newId("resp");
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private readonly splitter = new ThinkTagSplitter();
  private readonly tools = new Map<number, ToolState>();
  private readonly output: Json[] = [];
  private events: ResponseEvent[] = [];
  private sequence = 0;
  private started = false;
  private terminated = false;
  private open: OpenItem | undefined;
  private finishReason: unknown;
  private usageValue: TokenUsage | undefined;

  constructor(private readonly model: string) {}

  get usage(): TokenUsage | undefined {
    return this.usageValue;
  }

  get isTerminated(): boolean {
    return this.terminated;
  }

  /** Feeds one parsed chat chunk and returns the events it produced. */
  push(chunk: unknown): ResponseEvent[] {
    if (this.terminated) return [];
    this.events = [];
    this.ensureStarted();
    const root = asObject(chunk);
    if (!root) return this.take();

    const error = asObject(root.error);
    if (error) {
      this.failInternal(
        "upstream_error",
        typeof error.message === "string"
          ? error.message
          : "The upstream provider reported an error.",
      );
      return this.take();
    }

    this.usageValue = extractUsage(root) ?? this.usageValue;
    const choice = asObject(Array.isArray(root.choices) ? root.choices[0] : undefined);
    if (choice?.finish_reason) this.finishReason = choice.finish_reason;
    const delta = asObject(choice?.delta);
    if (delta) this.applyDelta(delta);
    return this.take();
  }

  /** Upstream finished normally (`[DONE]` or end of stream). */
  finish(): ResponseEvent[] {
    if (this.terminated) return [];
    this.events = [];
    this.ensureStarted();
    this.applySplit(this.splitter.flush());
    this.closeOpen();
    const reason = incompleteReason(this.finishReason);
    const status: ResponseStatus = reason ? "incomplete" : "completed";
    this.emit(reason ? "response.incomplete" : "response.completed", {
      response: this.snapshot(status, { incomplete: reason }),
    });
    this.terminated = true;
    return this.take();
  }

  /** Upstream broke after output started: the stream ends with `response.failed`. */
  fail(code: string, message: string): ResponseEvent[] {
    if (this.terminated) return [];
    this.events = [];
    this.ensureStarted();
    this.failInternal(code, message);
    return this.take();
  }

  private failInternal(code: string, message: string): void {
    this.emit("response.failed", {
      response: this.snapshot("failed", { error: { code, message } }),
    });
    this.terminated = true;
  }

  private take(): ResponseEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  private emit(type: string, payload: Json): void {
    this.events.push({ type, data: { type, sequence_number: this.sequence, ...payload } });
    this.sequence += 1;
  }

  private snapshot(
    status: ResponseStatus,
    extra: Partial<Parameters<typeof buildResponseObject>[0]> = {},
  ): Json {
    return buildResponseObject({
      id: this.responseId,
      createdAt: this.createdAt,
      model: this.model,
      status,
      output: status === "in_progress" ? [] : this.output.filter(Boolean),
      usage: status === "in_progress" ? undefined : this.usageValue,
      ...extra,
    });
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.emit("response.created", { response: this.snapshot("in_progress") });
    this.emit("response.in_progress", { response: this.snapshot("in_progress") });
  }

  private applyDelta(delta: Json): void {
    if (typeof delta.content === "string" && delta.content) {
      this.applySplit(this.splitter.push(delta.content));
    }
    for (const field of ["reasoning_content", "reasoning"] as const) {
      const value = delta[field];
      if (typeof value === "string" && value) this.appendReasoning(value);
    }
    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((raw, position) => {
        const call = asObject(raw);
        if (call) this.applyToolCall(call, position);
      });
    }
  }

  private applySplit(split: { text: string; reasoning: string }): void {
    if (split.reasoning) this.appendReasoning(split.reasoning);
    if (split.text) this.appendText(split.text);
  }

  private appendReasoning(text: string): void {
    let open = this.open?.kind === "reasoning" ? this.open : undefined;
    if (!open) {
      this.closeOpen();
      const itemId = newId("rs");
      const outputIndex = this.output.length;
      this.output.push(reasoningItem(itemId, "", "in_progress"));
      open = { kind: "reasoning", itemId, outputIndex, text: "" };
      this.open = open;
      this.emit("response.output_item.added", {
        output_index: outputIndex,
        item: reasoningItem(itemId, "", "in_progress"),
      });
      this.emit("response.reasoning_summary_part.added", {
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    }
    open.text += text;
    this.emit("response.reasoning_summary_text.delta", {
      item_id: open.itemId,
      output_index: open.outputIndex,
      summary_index: 0,
      delta: text,
    });
  }

  private appendText(text: string): void {
    let open = this.open?.kind === "message" ? this.open : undefined;
    if (!open) {
      this.closeOpen();
      const itemId = newId("msg");
      const outputIndex = this.output.length;
      this.output.push(messageItem(itemId, "", "in_progress"));
      open = { kind: "message", itemId, outputIndex, text: "" };
      this.open = open;
      this.emit("response.output_item.added", {
        output_index: outputIndex,
        item: messageItem(itemId, "", "in_progress"),
      });
      this.emit("response.content_part.added", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: outputTextPart(""),
      });
    }
    open.text += text;
    this.emit("response.output_text.delta", {
      item_id: open.itemId,
      output_index: open.outputIndex,
      content_index: 0,
      delta: text,
      logprobs: [],
    });
  }

  private applyToolCall(call: Json, position: number): void {
    const index = typeof call.index === "number" ? call.index : position;
    let tool = this.tools.get(index);
    if (!tool) {
      this.closeOpen();
      tool = {
        itemId: newId("fc"),
        callId: "",
        name: "",
        args: "",
        outputIndex: this.output.length,
        announced: false,
        pendingDelta: "",
        closed: false,
      };
      this.output.push(functionCallItem(tool.itemId, "", "", "", "in_progress"));
      this.tools.set(index, tool);
      this.open = { kind: "tool", tool };
    } else if (!tool.closed && !(this.open?.kind === "tool" && this.open.tool === tool)) {
      this.closeOpen();
      this.open = { kind: "tool", tool };
    }

    if (typeof call.id === "string" && call.id) tool.callId = call.id;
    const fn = asObject(call.function);
    if (typeof fn?.name === "string") tool.name += fn.name;
    const args = typeof fn?.arguments === "string" ? fn.arguments : "";
    tool.args += args;
    if (tool.closed) return;

    if (!tool.announced && tool.name) this.announceTool(tool);
    if (!args) return;
    if (tool.announced) this.emitArgumentsDelta(tool, args);
    else tool.pendingDelta += args;
  }

  private announceTool(tool: ToolState): void {
    if (!tool.callId) tool.callId = newId("call");
    tool.announced = true;
    this.emit("response.output_item.added", {
      output_index: tool.outputIndex,
      item: functionCallItem(tool.itemId, tool.callId, tool.name, "", "in_progress"),
    });
    if (tool.pendingDelta) {
      this.emitArgumentsDelta(tool, tool.pendingDelta);
      tool.pendingDelta = "";
    }
  }

  private emitArgumentsDelta(tool: ToolState, delta: string): void {
    this.emit("response.function_call_arguments.delta", {
      item_id: tool.itemId,
      output_index: tool.outputIndex,
      delta,
    });
  }

  private closeOpen(): void {
    const open = this.open;
    if (!open) return;
    this.open = undefined;
    if (open.kind === "reasoning") {
      this.emit("response.reasoning_summary_text.done", {
        item_id: open.itemId,
        output_index: open.outputIndex,
        summary_index: 0,
        text: open.text,
      });
      this.emit("response.reasoning_summary_part.done", {
        item_id: open.itemId,
        output_index: open.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: open.text },
      });
      this.finishItem(open.outputIndex, reasoningItem(open.itemId, open.text, "completed"));
    } else if (open.kind === "message") {
      this.emit("response.output_text.done", {
        item_id: open.itemId,
        output_index: open.outputIndex,
        content_index: 0,
        text: open.text,
        logprobs: [],
      });
      this.emit("response.content_part.done", {
        item_id: open.itemId,
        output_index: open.outputIndex,
        content_index: 0,
        part: outputTextPart(open.text),
      });
      this.finishItem(open.outputIndex, messageItem(open.itemId, open.text, "completed"));
    } else {
      const { tool } = open;
      if (!tool.announced) this.announceTool(tool);
      tool.closed = true;
      this.emit("response.function_call_arguments.done", {
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        name: tool.name,
        arguments: tool.args,
      });
      this.finishItem(
        tool.outputIndex,
        functionCallItem(tool.itemId, tool.callId, tool.name, tool.args || "{}", "completed"),
      );
    }
  }

  private finishItem(outputIndex: number, item: Json): void {
    this.output[outputIndex] = item;
    this.emit("response.output_item.done", { output_index: outputIndex, item });
  }
}

import { parseToolArguments } from "@/server/gateway/transcript/diff";
import type { CapturedResponse, OutputCapture } from "@/server/gateway/transcript/response-capture";

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface CallBuffer {
  callId?: string;
  name?: string;
  args: string;
}

/**
 * Accumulates assistant output from native Responses SSE events (or one complete response
 * object): output text, reasoning summaries, function calls and errors. Pure in-memory work;
 * events are forwarded to the client first and only observed here.
 */
export class ResponsesCapture implements OutputCapture {
  private text = "";
  private reasoning = "";
  private error: string | undefined;
  /** Items whose text arrived as deltas; their `output_item.done` text is not added again. */
  private readonly streamedItems = new Set<string>();
  private readonly lastSummaryIndex = new Map<string, number>();
  private readonly calls = new Map<string, CallBuffer>();
  private readonly callOrder: string[] = [];
  private sawAnyOutput = false;

  pushEvent(data: string, eventName?: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const event = asObject(parsed);
    if (!event) return;
    const type = eventName || asString(event.type);

    switch (type) {
      case "response.output_text.delta":
        this.addText(asString(event.item_id), asString(event.delta));
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        this.addReasoning(event);
        break;
      case "response.output_item.added":
        this.openItem(asObject(event.item));
        break;
      case "response.function_call_arguments.delta":
        this.addArguments(asString(event.item_id), asString(event.delta));
        break;
      case "response.output_item.done":
        this.closeItem(asObject(event.item));
        break;
      case "response.completed":
      case "response.incomplete":
        this.fallbackFromResponse(asObject(event.response));
        break;
      case "response.failed": {
        const error = asObject(asObject(event.response)?.error);
        this.error = asString(error?.message) ?? "upstream response failed";
        break;
      }
      case "error":
        this.error = asString(event.message) ?? asString(asObject(event.error)?.message) ?? "error";
        break;
      default:
        break;
    }
  }

  /** Reads a complete (non-streamed) Responses object. */
  captureCompletion(body: unknown): void {
    const root = asObject(body);
    if (!root) return;
    const error = asObject(root.error);
    if (error) this.error = asString(error.message) ?? "upstream response failed";
    this.readOutput(root.output);
  }

  finish(): CapturedResponse {
    const toolCalls = this.callOrder.flatMap((itemId) => {
      const call = this.calls.get(itemId);
      return call
        ? [
            {
              id: call.callId,
              name: call.name,
              args: parseToolArguments(call.args),
              rawArguments: call.args,
            },
          ]
        : [];
    });
    return {
      text: this.text.trim(),
      reasoning: this.reasoning.trim(),
      toolCalls,
      error: this.error,
    };
  }

  private addText(itemId: string | undefined, delta: string | undefined): void {
    if (!delta) return;
    this.text += delta;
    this.sawAnyOutput = true;
    if (itemId) this.streamedItems.add(itemId);
  }

  private addReasoning(event: Json): void {
    const delta = asString(event.delta);
    if (!delta) return;
    const itemId = asString(event.item_id) ?? "";
    const summaryIndex = typeof event.summary_index === "number" ? event.summary_index : 0;
    const previous = this.lastSummaryIndex.get(itemId);
    // Separate the summary parts of one reasoning item.
    if (previous !== undefined && previous !== summaryIndex) this.reasoning += "\n\n";
    this.lastSummaryIndex.set(itemId, summaryIndex);
    this.reasoning += delta;
    this.sawAnyOutput = true;
  }

  private bufferFor(itemId: string): CallBuffer {
    let buffer = this.calls.get(itemId);
    if (!buffer) {
      buffer = { args: "" };
      this.calls.set(itemId, buffer);
      this.callOrder.push(itemId);
    }
    return buffer;
  }

  private openItem(item: Json | undefined): void {
    if (item?.type !== "function_call") return;
    const itemId = asString(item.id) ?? asString(item.call_id) ?? `call-${this.callOrder.length}`;
    const buffer = this.bufferFor(itemId);
    buffer.callId = asString(item.call_id) ?? buffer.callId;
    buffer.name = asString(item.name) ?? buffer.name;
    this.sawAnyOutput = true;
  }

  private addArguments(itemId: string | undefined, delta: string | undefined): void {
    if (!itemId || !delta) return;
    this.bufferFor(itemId).args += delta;
  }

  private closeItem(item: Json | undefined): void {
    if (!item) return;
    const itemId = asString(item.id) ?? "";
    if (item.type === "function_call") {
      const buffer = this.bufferFor(itemId || asString(item.call_id) || "call");
      buffer.callId = asString(item.call_id) ?? buffer.callId;
      buffer.name = asString(item.name) ?? buffer.name;
      const finalArgs = asString(item.arguments);
      if (finalArgs !== undefined) buffer.args = finalArgs;
      this.sawAnyOutput = true;
    } else if (item.type === "message" && !this.streamedItems.has(itemId)) {
      this.addMessageText(item);
    } else if (item.type === "reasoning" && !this.lastSummaryIndex.has(itemId)) {
      this.addReasoningItem(item);
    }
  }

  /** `response.completed` carries the whole output; use it when no events delivered anything. */
  private fallbackFromResponse(response: Json | undefined): void {
    if (!response || this.sawAnyOutput) return;
    this.readOutput(response.output);
  }

  private readOutput(output: unknown): void {
    if (!Array.isArray(output)) return;
    for (const raw of output) {
      const item = asObject(raw);
      if (!item) continue;
      if (item.type === "message") this.addMessageText(item);
      else if (item.type === "reasoning") this.addReasoningItem(item);
      else if (item.type === "function_call") this.closeItem(item);
    }
  }

  private addMessageText(item: Json): void {
    if (!Array.isArray(item.content)) return;
    for (const raw of item.content) {
      const part = asObject(raw);
      if (part?.type === "output_text") this.text += asString(part.text) ?? "";
      else if (part?.type === "refusal") this.text += asString(part.refusal) ?? "";
    }
    this.sawAnyOutput = true;
  }

  private addReasoningItem(item: Json): void {
    if (!Array.isArray(item.summary)) return;
    const texts = item.summary.flatMap((raw) => {
      const text = asString(asObject(raw)?.text);
      return text ? [text] : [];
    });
    if (texts.length === 0) return;
    if (this.reasoning) this.reasoning += "\n\n";
    this.reasoning += texts.join("\n\n");
    this.sawAnyOutput = true;
  }
}

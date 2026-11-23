import { parseToolArguments } from "@/server/gateway/transcript/diff";
import { splitThinkTags, ThinkTagSplitter } from "@/server/gateway/transcript/think-splitter";

export interface CapturedToolCall {
  id?: string;
  name?: string;
  args: unknown;
}

/** What the assistant produced for one request; held in memory and persisted after the stream. */
export interface CapturedResponse {
  text: string;
  reasoning: string;
  toolCalls: CapturedToolCall[];
  /** Error text from an error chunk sent by the upstream inside the stream. */
  error?: string;
}

interface ToolCallBuffer {
  id?: string;
  name?: string;
  args: string;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/**
 * Accumulates assistant output from upstream SSE `data:` payloads (or one JSON completion).
 * Pure in-memory work: chunks are forwarded to the client first, this only observes them.
 */
export class ResponseCapture {
  private text = "";
  private reasoning = "";
  private error: string | undefined;
  private readonly splitter = new ThinkTagSplitter();
  private readonly toolCalls = new Map<number, ToolCallBuffer>();

  /** Feeds one SSE data payload (the text after `data:`); non-JSON payloads are ignored. */
  pushEvent(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const event = asObject(parsed);
    if (!event) return;

    const errorBody = asObject(event.error);
    if (errorBody) {
      this.error = typeof errorBody.message === "string" ? errorBody.message : "upstream error";
      return;
    }

    const choices = Array.isArray(event.choices) ? event.choices : [];
    const delta = asObject(asObject(choices[0])?.delta);
    if (!delta) return;

    if (typeof delta.content === "string") this.addContent(this.splitter.push(delta.content));
    for (const field of ["reasoning_content", "reasoning"] as const) {
      if (typeof delta[field] === "string") this.reasoning += delta[field];
    }
    if (Array.isArray(delta.tool_calls)) this.addToolCallDeltas(delta.tool_calls);
  }

  /** Reads a complete (non-streamed) chat completion body. */
  captureCompletion(body: unknown): void {
    const root = asObject(body);
    const choices = Array.isArray(root?.choices) ? root.choices : [];
    const message = asObject(asObject(choices[0])?.message);
    if (!message) return;

    if (typeof message.content === "string") {
      const split = splitThinkTags(message.content);
      this.text += split.text;
      this.reasoning += split.reasoning;
    }
    for (const field of ["reasoning_content", "reasoning"] as const) {
      if (typeof message[field] === "string") this.reasoning += message[field];
    }
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((call, index) => {
        this.addToolCallDeltas([{ ...(asObject(call) ?? {}), index }]);
      });
    }
  }

  /** Flushes held-back tag text and returns the assembled response. */
  finish(): CapturedResponse {
    this.addContent(this.splitter.flush());
    const toolCalls = [...this.toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        args: parseToolArguments(call.args),
      }));
    return {
      text: this.text.trim(),
      reasoning: this.reasoning.trim(),
      toolCalls,
      error: this.error,
    };
  }

  private addContent(split: { text: string; reasoning: string }): void {
    this.text += split.text;
    this.reasoning += split.reasoning;
  }

  private addToolCallDeltas(deltas: unknown[]): void {
    deltas.forEach((raw, position) => {
      const call = asObject(raw);
      if (!call) return;
      const index = typeof call.index === "number" ? call.index : position;
      const buffer = this.toolCalls.get(index) ?? { args: "" };
      if (typeof call.id === "string") buffer.id = call.id;
      const fn = asObject(call.function);
      if (typeof fn?.name === "string") buffer.name = (buffer.name ?? "") + fn.name;
      if (typeof fn?.arguments === "string") buffer.args += fn.arguments;
      this.toolCalls.set(index, buffer);
    });
  }
}

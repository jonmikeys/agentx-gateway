import { describe, expect, it } from "vitest";
import { chatCompletionToResponse } from "@/server/gateway/responses/response-translate";
import {
  ChatToResponsesStream,
  type ResponseEvent,
} from "@/server/gateway/responses/stream-translate";
import { formatSseEvent, SseParser } from "@/server/gateway/sse";

type Json = Record<string, unknown>;

const chunk = (delta: Json, finish: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
});

function run(chunks: unknown[], finishWith: "finish" | "fail" = "finish"): ResponseEvent[] {
  const stream = new ChatToResponsesStream("avatar-default");
  const events = chunks.flatMap((entry) => stream.push(entry));
  return [...events, ...(finishWith === "finish" ? stream.finish() : stream.fail("boom", "lost"))];
}

const types = (events: ResponseEvent[]) => events.map((event) => event.type);

describe("ChatToResponsesStream", () => {
  it("emits the text sequence in spec order with monotonic sequence numbers", () => {
    const events = run([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }, "stop"),
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    ]);
    expect(types(events)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const sequence = events.map((event) => event.data.sequence_number as number);
    expect(sequence).toEqual(sequence.map((_, index) => index));
    expect(events.every((event) => event.data.type === event.type)).toBe(true);

    const completed = events.at(-1)?.data.response as Json;
    expect(completed.status).toBe("completed");
    expect(completed.model).toBe("avatar-default");
    expect(completed.usage).toMatchObject({ input_tokens: 5, output_tokens: 3, total_tokens: 8 });
    const message = (completed.output as Json[])[0];
    expect(message).toMatchObject({ type: "message", role: "assistant", status: "completed" });
    expect(message.content).toEqual([
      { type: "output_text", text: "Hello", annotations: [], logprobs: [] },
    ]);
  });

  it("streams reasoning before the message and splits think tags across chunks", () => {
    const events = run([
      chunk({ reasoning_content: "hm " }),
      chunk({ content: "<thi" }),
      chunk({ content: "nk>deep</th" }),
      chunk({ content: "ink>Answer" }, "stop"),
    ]);
    expect(types(events)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const deltas = events.filter((event) => event.type.endsWith("text.delta"));
    expect(deltas.map((event) => event.data.delta)).toEqual(["hm ", "deep", "Answer"]);
    const output = (events.at(-1)?.data.response as Json).output as Json[];
    expect(output.map((item) => item.type)).toEqual(["reasoning", "message"]);
    expect(output[0].summary).toEqual([{ type: "summary_text", text: "hm deep" }]);
  });

  it("streams tool call argument deltas and completes the function_call item", () => {
    const events = run([
      chunk({ content: "Let me. " }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_9",
            type: "function",
            function: { name: "show_image", arguments: "" },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"media_id":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"sunset"}' } }] }, "tool_calls"),
    ]);
    expect(types(events).slice(-6)).toEqual([
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const done = events.find((event) => event.type === "response.function_call_arguments.done");
    expect(done?.data.arguments).toBe('{"media_id":"sunset"}');
    const output = (events.at(-1)?.data.response as Json).output as Json[];
    expect(output[1]).toMatchObject({
      type: "function_call",
      call_id: "call_9",
      name: "show_image",
      arguments: '{"media_id":"sunset"}',
      status: "completed",
    });
  });

  it("handles two tool calls delivered in one chunk and a late function name", () => {
    const events = run([
      chunk({
        tool_calls: [
          { index: 0, id: "a", function: { name: "one", arguments: "{}" } },
          { index: 1, id: "b", function: { name: "two", arguments: "{}" } },
        ],
      }),
      chunk({ tool_calls: [{ index: 2, id: "c", function: { arguments: "{" } }] }),
      chunk(
        { tool_calls: [{ index: 2, function: { name: "three", arguments: "}" } }] },
        "tool_calls",
      ),
    ]);
    const output = (events.at(-1)?.data.response as Json).output as Json[];
    expect(output.map((item) => item.name)).toEqual(["one", "two", "three"]);
    const added = events.filter((event) => event.type === "response.output_item.added");
    // The item is announced only once its name is known.
    expect((added[2].data.item as Json).name).toBe("three");
  });

  it("ends with response.incomplete for finish_reason length", () => {
    const events = run([chunk({ content: "cut" }, "length")]);
    const last = events.at(-1);
    expect(last?.type).toBe("response.incomplete");
    expect(last?.data.response).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
  });

  it("ends with response.failed after an upstream break", () => {
    const events = run([chunk({ content: "partial" })], "fail");
    const last = events.at(-1);
    expect(last?.type).toBe("response.failed");
    expect(last?.data.response).toMatchObject({
      status: "failed",
      error: { code: "boom", message: "lost" },
    });
    expect(types(events)).not.toContain("response.completed");
  });

  it("fails on an in-stream upstream error chunk and ignores what follows", () => {
    const stream = new ChatToResponsesStream("r");
    stream.push(chunk({ content: "x" }));
    const failed = stream.push({ error: { message: "overloaded" } });
    expect(failed.at(-1)?.type).toBe("response.failed");
    expect(stream.push(chunk({ content: "more" }))).toEqual([]);
    expect(stream.finish()).toEqual([]);
  });

  it("is unaffected by how the upstream SSE bytes are split", () => {
    const wire =
      `data: ${JSON.stringify(chunk({ content: "Hel" }))}\n\n` +
      `data: ${JSON.stringify(chunk({ content: "lo" }, "stop"))}\n\n` +
      "data: [DONE]\n\n";
    const results: string[] = [];
    for (const size of [1, 3, 7, wire.length]) {
      const parser = new SseParser();
      const stream = new ChatToResponsesStream("r");
      const out: ResponseEvent[] = [];
      for (let index = 0; index < wire.length; index += size) {
        for (const event of parser.push(wire.slice(index, index + size))) {
          if (event.data === "[DONE]") out.push(...stream.finish());
          else out.push(...stream.push(JSON.parse(event.data)));
        }
      }
      results.push(
        out
          .filter((event) => event.type === "response.output_text.delta")
          .map((event) => event.data.delta)
          .join("") + types(out).length,
      );
    }
    expect(new Set(results).size).toBe(1);
  });

  it("frames events as event: lines with JSON data", () => {
    const [event] = run([chunk({ content: "x" })]);
    const frame = formatSseEvent(event.type, JSON.stringify(event.data));
    expect(frame.startsWith("event: response.created\ndata: {")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
  });
});

describe("chatCompletionToResponse", () => {
  const completion = (message: Json, finish = "stop") => ({
    choices: [{ index: 0, message, finish_reason: finish }],
  });
  const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };

  it("translates text with usage and the route slug as model", () => {
    const { response } = chatCompletionToResponse(
      completion({ role: "assistant", content: "Hi" }),
      "avatar-default",
      usage,
    );
    expect(response).toMatchObject({
      object: "response",
      status: "completed",
      model: "avatar-default",
      error: null,
      incomplete_details: null,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    });
    expect(String(response.id).startsWith("resp_")).toBe(true);
    const [message] = response.output as Json[];
    expect(String(message.id).startsWith("msg_")).toBe(true);
    expect(message).toMatchObject({ type: "message", role: "assistant", status: "completed" });
    expect(message.content).toEqual([
      { type: "output_text", text: "Hi", annotations: [], logprobs: [] },
    ]);
  });

  it("emits reasoning (field or think tags), message and function_call items in order", () => {
    const { response, captured } = chatCompletionToResponse(
      completion(
        {
          role: "assistant",
          content: "<think>plan</think>Answer",
          reasoning_content: "first ",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
          ],
        },
        "tool_calls",
      ),
      "r",
      usage,
    );
    const output = response.output as Json[];
    expect(output.map((item) => item.type)).toEqual(["reasoning", "message", "function_call"]);
    expect(output[0].summary).toEqual([{ type: "summary_text", text: "planfirst" }]);
    expect(output[2]).toMatchObject({
      call_id: "call_1",
      name: "f",
      arguments: '{"a":1}',
      status: "completed",
    });
    expect(String(output[2].id).startsWith("fc_")).toBe(true);
    expect(captured.text).toBe("Answer");
  });

  it("maps finish_reason length to incomplete with details", () => {
    const { response } = chatCompletionToResponse(
      completion({ role: "assistant", content: "cut" }, "length"),
      "r",
      undefined,
    );
    expect(response).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      usage: null,
    });
  });
});

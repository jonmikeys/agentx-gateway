import { describe, expect, it } from "vitest";
import {
  buildChatRequest,
  normalizeResponsesInput,
} from "@/server/gateway/responses/request-translate";
import { ChatToResponsesStream } from "@/server/gateway/responses/stream-translate";
import { formatSseEvent } from "@/server/gateway/sse";
import { ResponsesCapture } from "@/server/gateway/transcript/responses-capture";
import {
  readUnityJson,
  readUnityStream,
  unityRequestBody,
  unityToolRoundBody,
} from "../support/unity-responses-client";

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
});

function translatedWire(chunks: unknown[]): string {
  const stream = new ChatToResponsesStream("avatar-default");
  const events = [...chunks.flatMap((entry) => stream.push(entry)), ...stream.finish()];
  return events.map((event) => formatSseEvent(event.type, JSON.stringify(event.data))).join("");
}

describe("Unity Responses adapter contract (ResponsesApiAdapter.cs)", () => {
  it("accepts the translated stream: text, reasoning summary and function_call round", () => {
    const wire = translatedWire([
      chunk({ reasoning_content: "thinking " }),
      chunk({ content: "Let me show that. " }),
      chunk({
        tool_calls: [
          { index: 0, id: "call_mock_1", function: { name: "show_image", arguments: "" } },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"media_id":"sunset"}' } }] }),
      chunk({}, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    ]);
    // No [DONE] sentinel: JObject.Parse would throw on it.
    expect(wire).not.toContain("[DONE]");
    const round = readUnityStream(wire);
    expect(round.text).toBe("Let me show that. ");
    expect(round.reasoning).toBe("thinking ");
    expect(round.toolCalls).toEqual([
      { id: "call_mock_1", name: "show_image", arguments: '{"media_id":"sunset"}' },
    ]);
    expect(round.eventTypes).toContain("response.completed");
    expect(round.eventTypes).not.toContain("response.failed");
  });

  it("rejects a failed or incomplete stream exactly like the adapter (it throws)", () => {
    const stream = new ChatToResponsesStream("r");
    const events = [...stream.push(chunk({ content: "x" })), ...stream.fail("c", "lost")];
    const wire = events
      .map((event) => formatSseEvent(event.type, JSON.stringify(event.data)))
      .join("");
    expect(() => readUnityStream(wire)).toThrow(/stream failed/);
  });

  it("can echo the output items back and the follow-up request translates to chat", () => {
    const wire = translatedWire([
      chunk({ content: "Sure." }),
      chunk(
        { tool_calls: [{ index: 0, id: "call_mock_1", function: { name: "f", arguments: "{}" } }] },
        "tool_calls",
      ),
    ]);
    // The adapter echoes `response.output` verbatim into the next request's input.
    const completed = wire
      .split("\n\n")
      .filter((frame) => frame.startsWith("event: response.completed"))
      .map((frame) => JSON.parse(frame.split("data: ")[1]))[0];
    const echoed = completed.response.output as Record<string, unknown>[];
    const body = unityToolRoundBody("avatar-default", echoed, true);
    const messages = normalizeResponsesInput(body);
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(messages[2].tool_calls).toHaveLength(1);
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_mock_1" });
  });

  it("translates the exact request body Unity sends (every field accounted for)", () => {
    const body = unityRequestBody("avatar-default", true);
    const messages = normalizeResponsesInput(body);
    const chat = buildChatRequest(body, messages);
    expect(chat).toEqual({
      messages: [
        { role: "system", content: "You are Aiko.\n\nUse the tools to show media." },
        { role: "user", content: "Show me a sunset photo, please." },
      ],
      temperature: 0.7,
      tools: [
        {
          type: "function",
          function: {
            name: "show_image",
            description: "Shows an image on screen",
            parameters: {
              type: "object",
              properties: { media_id: { type: "string" } },
              required: ["media_id"],
            },
          },
        },
      ],
      tool_choice: "auto",
      reasoning_effort: "medium",
    });
  });

  it("parses a complete JSON response the way ReadCompletionRound does", () => {
    const capture = new ResponsesCapture();
    capture.captureCompletion({
      output: [{ type: "message", content: [{ type: "output_text", text: "Hi" }] }],
    });
    expect(capture.finish().text).toBe("Hi");
    expect(readUnityJson(JSON.stringify({ status: "completed", output: [] })).text).toBe("");
    expect(() => readUnityJson(JSON.stringify({ status: "incomplete", output: [] }))).toThrow();
  });
});

describe("ResponsesCapture (native passthrough observer)", () => {
  const feed = (capture: ResponsesCapture, events: [string, Record<string, unknown>][]) => {
    for (const [type, payload] of events)
      capture.pushEvent(JSON.stringify({ type, ...payload }), type);
  };

  it("collects text, reasoning and function calls from events", () => {
    const capture = new ResponsesCapture();
    feed(capture, [
      [
        "response.reasoning_summary_text.delta",
        { item_id: "rs", summary_index: 0, delta: "think" },
      ],
      ["response.output_text.delta", { item_id: "m", delta: "Hel" }],
      ["response.output_text.delta", { item_id: "m", delta: "lo" }],
      [
        "response.output_item.done",
        { item: { id: "m", type: "message", content: [{ type: "output_text", text: "Hello" }] } },
      ],
      [
        "response.output_item.added",
        { item: { id: "fc", type: "function_call", call_id: "c1", name: "f", arguments: "" } },
      ],
      ["response.function_call_arguments.delta", { item_id: "fc", delta: '{"a"' }],
      ["response.function_call_arguments.delta", { item_id: "fc", delta: ":1}" }],
      [
        "response.output_item.done",
        {
          item: { id: "fc", type: "function_call", call_id: "c1", name: "f", arguments: '{"a":1}' },
        },
      ],
      ["response.completed", { response: { output: [], usage: {} } }],
    ]);
    expect(capture.finish()).toEqual({
      text: "Hello",
      reasoning: "think",
      toolCalls: [{ id: "c1", name: "f", args: { a: 1 }, rawArguments: '{"a":1}' }],
      error: undefined,
    });
  });

  it("falls back to the completed response output and records failures", () => {
    const capture = new ResponsesCapture();
    feed(capture, [
      [
        "response.completed",
        {
          response: {
            output: [{ type: "message", content: [{ type: "output_text", text: "Only here" }] }],
          },
        },
      ],
    ]);
    expect(capture.finish().text).toBe("Only here");

    const failed = new ResponsesCapture();
    feed(failed, [["response.failed", { response: { error: { message: "bad" } } }]]);
    expect(failed.finish().error).toBe("bad");
  });
});

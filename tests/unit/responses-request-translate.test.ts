import { describe, expect, it } from "vitest";
import {
  buildChatRequest,
  normalizeResponsesInput,
  TranslationError,
} from "@/server/gateway/responses/request-translate";

function translate(body: Record<string, unknown>) {
  const messages = normalizeResponsesInput(body);
  return { messages, chat: buildChatRequest(body, messages) };
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof TranslationError ? error.code : "other";
  }
  return undefined;
}

describe("Responses -> Chat request translation", () => {
  it("turns a string input into one user message", () => {
    expect(translate({ input: "hi" }).messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("puts instructions first as a system message", () => {
    const { messages } = translate({ instructions: "Be brief.", input: "hi" });
    expect(messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
    ]);
  });

  it("maps message items for every role and string or parts content", () => {
    const { messages } = translate({
      input: [
        { role: "system", content: "sys" },
        { role: "developer", content: "dev" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "a" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "b" }] },
      ],
    });
    expect(messages).toEqual([
      { role: "system", content: "sys" },
      { role: "system", content: "dev" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
  });

  it("maps input_image to an image_url part", () => {
    const { messages } = translate({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "what is this?" },
            { type: "input_image", image_url: "https://x.test/a.png", detail: "high" },
          ],
        },
      ],
    });
    expect(messages[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "https://x.test/a.png", detail: "high" } },
    ]);
  });

  it("rejects file and audio parts and item references", () => {
    expect(
      codeOf(() =>
        normalizeResponsesInput({ input: [{ role: "user", content: [{ type: "input_file" }] }] }),
      ),
    ).toBe("unsupported_input");
    expect(
      codeOf(() => normalizeResponsesInput({ input: [{ type: "item_reference", id: "x" }] })),
    ).toBe("unsupported_parameter");
  });

  it("merges an assistant message and its function_call items into one assistant message", () => {
    const { messages } = translate({
      input: [
        { role: "user", content: "show it" },
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Sure." }] },
        { type: "function_call", call_id: "call_1", name: "show_image", arguments: '{"a":1}' },
        { type: "function_call", call_id: "call_2", name: "list_media", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
        { type: "function_call_output", call_id: "call_2", output: { items: [] } },
      ],
    });
    expect(messages).toEqual([
      { role: "user", content: "show it" },
      {
        role: "assistant",
        content: "Sure.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "show_image", arguments: '{"a":1}' },
          },
          { id: "call_2", type: "function", function: { name: "list_media", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
      { role: "tool", tool_call_id: "call_2", content: '{"items":[]}' },
    ]);
  });

  it("starts an assistant message for a function_call with no preceding text", () => {
    const { messages } = translate({
      input: [
        { role: "user", content: "go" },
        { type: "function_call", call_id: "c", name: "f", arguments: "{}" },
      ],
    });
    expect(messages[1]).toMatchObject({ role: "assistant", content: null });
  });

  it("converts flat function tools and keeps description, parameters and strict", () => {
    const { chat } = translate({
      input: "hi",
      tools: [
        {
          type: "function",
          name: "show_image",
          description: "Shows an image",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      ],
    });
    expect(chat.tools).toEqual([
      {
        type: "function",
        function: {
          name: "show_image",
          description: "Shows an image",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      },
    ]);
  });

  it("rejects non-function tools with unsupported_tool", () => {
    expect(codeOf(() => translate({ input: "hi", tools: [{ type: "web_search" }] }))).toBe(
      "unsupported_tool",
    );
  });

  it.each([
    ["auto", "auto"],
    ["none", "none"],
    ["required", "required"],
    [
      { type: "function", name: "f" },
      { type: "function", function: { name: "f" } },
    ],
  ])("maps tool_choice %j", (choice, expected) => {
    const { chat } = translate({
      input: "hi",
      tools: [{ type: "function", name: "f" }],
      tool_choice: choice,
    });
    expect(chat.tool_choice).toEqual(expected);
  });

  it("passes sampling fields and maps max_output_tokens and reasoning.effort", () => {
    const { chat } = translate({
      input: "hi",
      temperature: 0.4,
      top_p: 0.9,
      max_output_tokens: 128,
      reasoning: { effort: "low", summary: "auto" },
      store: false,
      include: ["reasoning.encrypted_content"],
      something_unknown: 1,
    });
    expect(chat).toEqual({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.4,
      top_p: 0.9,
      max_tokens: 128,
      reasoning_effort: "low",
    });
  });

  it("drops reasoning and unknown items when translating", () => {
    const { messages } = translate({
      input: [{ type: "reasoning", id: "r", summary: [] }, { type: "web_search_call" }, "x"],
    });
    expect(messages).toEqual([]);
  });
});

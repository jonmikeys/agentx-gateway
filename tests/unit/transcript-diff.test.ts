import { describe, expect, it } from "vitest";
import { diffNewItems, hashSystemPrompt } from "@/server/gateway/transcript/diff";

const system = { role: "system", content: "You are an avatar." };

describe("diffNewItems", () => {
  it("first request: stores every non-system message and the system prompt", () => {
    const diff = diffNewItems([system, { role: "user", content: "Hi" }], true);
    expect(diff.systemPrompt).toBe("You are an avatar.");
    expect(diff.items).toEqual([{ kind: "user_message", content: "Hi" }]);
    expect(diff.startsTurn).toBe(true);
  });

  it("follow-up with full history: only messages after the last assistant message are new", () => {
    const diff = diffNewItems(
      [
        system,
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "How are you?" },
      ],
      false,
    );
    expect(diff.items).toEqual([{ kind: "user_message", content: "How are you?" }]);
    expect(diff.startsTurn).toBe(true);
  });

  it("tool round: only the tool results are new and no turn starts", () => {
    const diff = diffNewItems(
      [
        system,
        { role: "user", content: "Show me a cat" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "show_image", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "shown" },
      ],
      false,
    );
    expect(diff.items).toEqual([{ kind: "tool_result", content: "shown", toolCallId: "call_1" }]);
    expect(diff.startsTurn).toBe(false);
  });

  it("first request with prior assistant history stores tool calls too", () => {
    const diff = diffNewItems(
      [
        { role: "user", content: "Show" },
        {
          role: "assistant",
          content: "Sure",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "show_image", arguments: '{"media_id":"a"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
      true,
    );
    expect(diff.items.map((item) => item.kind)).toEqual([
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_result",
    ]);
    expect(diff.items[2]).toMatchObject({ toolName: "show_image", toolArgs: { media_id: "a" } });
  });

  it("handles content parts and invalid tool arguments", () => {
    const diff = diffNewItems(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image_url", image_url: { url: "x" } },
          ],
        },
        {
          role: "assistant",
          tool_calls: [{ id: "c", function: { name: "f", arguments: "{oops" } }],
        },
      ],
      true,
    );
    expect(diff.items[0].content).toBe("Look\n[image]");
    expect(diff.items[1]).toMatchObject({ toolArgs: { _raw: "{oops" } });
  });

  it("joins system and developer messages and hashes them; changes change the hash", () => {
    const a = diffNewItems([{ role: "developer", content: "A" }, system], true);
    expect(a.systemPrompt).toBe("A\n\nYou are an avatar.");
    const b = diffNewItems([{ role: "system", content: "Changed" }], true);
    expect(hashSystemPrompt(a.systemPrompt ?? "")).not.toBe(hashSystemPrompt(b.systemPrompt ?? ""));
    expect(diffNewItems([{ role: "user", content: "x" }], true).systemPrompt).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { redactText, redactValue } from "@/server/gateway/transcript/redaction";
import { ResponseCapture } from "@/server/gateway/transcript/response-capture";
import { splitThinkTags, ThinkTagSplitter } from "@/server/gateway/transcript/think-splitter";

const delta = (value: Record<string, unknown>) => JSON.stringify({ choices: [{ delta: value }] });

describe("ThinkTagSplitter", () => {
  it("separates reasoning from text in one chunk", () => {
    expect(splitThinkTags("<think>plan it</think>Hello")).toEqual({
      text: "Hello",
      reasoning: "plan it",
    });
  });

  it("handles tags split across chunks at every position", () => {
    const full = "<think>deep thought</think>Answer";
    for (let cut = 1; cut < full.length; cut += 1) {
      const splitter = new ThinkTagSplitter();
      const a = splitter.push(full.slice(0, cut));
      const b = splitter.push(full.slice(cut));
      const c = splitter.flush();
      expect(a.text + b.text + c.text).toBe("Answer");
      expect(a.reasoning + b.reasoning + c.reasoning).toBe("deep thought");
    }
  });

  it("keeps a lone less-than sign as text", () => {
    expect(splitThinkTags("1 < 2 and <b>bold</b>").text).toBe("1 < 2 and <b>bold</b>");
  });

  it("treats an unterminated think block as reasoning", () => {
    expect(splitThinkTags("<think>never closed")).toEqual({ text: "", reasoning: "never closed" });
  });
});

describe("ResponseCapture", () => {
  it("collects text, reasoning_content and reasoning fields", () => {
    const capture = new ResponseCapture();
    capture.pushEvent(delta({ reasoning_content: "think " }));
    capture.pushEvent(delta({ reasoning: "more" }));
    capture.pushEvent(delta({ content: "Hel" }));
    capture.pushEvent(delta({ content: "lo" }));
    capture.pushEvent("not json");
    expect(capture.finish()).toMatchObject({ text: "Hello", reasoning: "think more" });
  });

  it("extracts think tags split across stream chunks and strips them from the text", () => {
    const capture = new ResponseCapture();
    for (const part of ["<thi", "nk>weigh", "ing</th", "ink>The answer"]) {
      capture.pushEvent(delta({ content: part }));
    }
    expect(capture.finish()).toMatchObject({ text: "The answer", reasoning: "weighing" });
  });

  it("assembles tool calls from streamed deltas by index", () => {
    const capture = new ResponseCapture();
    capture.pushEvent(
      delta({
        tool_calls: [{ index: 0, id: "call_a", function: { name: "show_image", arguments: "" } }],
      }),
    );
    capture.pushEvent(delta({ tool_calls: [{ index: 0, function: { arguments: '{"media' } }] }));
    capture.pushEvent(
      delta({
        tool_calls: [
          { index: 1, id: "call_b", function: { name: "list_media", arguments: "{}" } },
          { index: 0, function: { arguments: '_id":"x"}' } },
        ],
      }),
    );
    expect(capture.finish().toolCalls).toEqual([
      { id: "call_a", name: "show_image", args: { media_id: "x" } },
      { id: "call_b", name: "list_media", args: {} },
    ]);
  });

  it("records an error chunk", () => {
    const capture = new ResponseCapture();
    capture.pushEvent(JSON.stringify({ error: { message: "boom", code: "x" } }));
    expect(capture.finish().error).toBe("boom");
  });

  it("reads a complete JSON completion", () => {
    const capture = new ResponseCapture();
    capture.captureCompletion({
      choices: [
        {
          message: {
            content: "<think>hmm</think>Done",
            reasoning_content: "also",
            tool_calls: [{ id: "c", function: { name: "f", arguments: '{"a":1}' } }],
          },
        },
      ],
    });
    expect(capture.finish()).toMatchObject({
      text: "Done",
      reasoning: "hmmalso",
      toolCalls: [{ id: "c", name: "f", args: { a: 1 } }],
    });
  });
});

describe("redaction", () => {
  it("masks emails and phone numbers", () => {
    expect(redactText("Mail me at jane.doe+x@example.co.uk or call +1 (555) 123-4567.")).toBe(
      "Mail me at [email] or call [phone].",
    );
  });

  it("leaves short numbers, prices and dates alone", () => {
    expect(redactText("It costs 1234 on 2024-05-06 at 10:30, room 42")).toBe(
      "It costs 1234 on 2024-05-06 at 10:30, room 42",
    );
  });

  it("redacts string leaves of JSON values", () => {
    expect(redactValue({ to: "a@b.io", n: 5, list: ["call 0612345678"] })).toEqual({
      to: "[email]",
      n: 5,
      list: ["call [phone]"],
    });
  });
});

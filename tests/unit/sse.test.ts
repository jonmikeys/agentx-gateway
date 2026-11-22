import { describe, expect, it } from "vitest";
import { formatSse, SseParser } from "@/server/gateway/sse";

function parseAll(chunks: string[]): string[] {
  const parser = new SseParser();
  const events = chunks.flatMap((chunk) => parser.push(chunk)).concat(parser.flush());
  return events.map((event) => event.data);
}

describe("SseParser", () => {
  it("parses simple events", () => {
    expect(parseAll(['data: {"a":1}\n\ndata: [DONE]\n\n'])).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("handles chunk boundaries inside a line", () => {
    expect(parseAll(["da", 'ta: {"a"', ":1}\n", "\ndata: [DO", "NE]\n\n"])).toEqual([
      '{"a":1}',
      "[DONE]",
    ]);
  });

  it("handles CRLF, including a split CR/LF pair", () => {
    expect(parseAll(["data: one\r\n\r\ndata: two\r", "\n\r\n"])).toEqual(["one", "two"]);
  });

  it("handles bare CR line endings", () => {
    expect(parseAll(["data: one\r\rdata: two\r\r"])).toEqual(["one", "two"]);
  });

  it("ignores comments and keep-alives", () => {
    expect(parseAll([": keep-alive\n\ndata: x\n\n: another\n"])).toEqual(["x"]);
  });

  it("joins multi-line data and tolerates a missing space after the colon", () => {
    expect(parseAll(["data:a\ndata: b\n\n"])).toEqual(["a\nb"]);
  });

  it("keeps event names and ignores unknown fields", () => {
    const parser = new SseParser();
    expect(parser.push("event: ping\nid: 7\ndata: x\n\n")).toEqual([{ event: "ping", data: "x" }]);
  });

  it("flushes an unterminated final event", () => {
    expect(parseAll(["data: tail"])).toEqual(["tail"]);
  });

  it("skips empty events", () => {
    expect(parseAll(["\n\n\ndata: x\n\n"])).toEqual(["x"]);
  });

  it("formats multi-line payloads", () => {
    expect(formatSse("a\nb")).toBe("data: a\ndata: b\n\n");
  });
});

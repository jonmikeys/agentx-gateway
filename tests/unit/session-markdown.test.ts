import { describe, expect, it } from "vitest";
import { renderSessionMarkdown } from "@/lib/session-markdown";
import type { SessionDetail, TranscriptItemView } from "@/lib/session-types";
import { csvField } from "@/server/services/session-export";

function item(
  partial: Partial<TranscriptItemView> & Pick<TranscriptItemView, "kind">,
): TranscriptItemView {
  return {
    id: crypto.randomUUID(),
    turn_id: "t1",
    seq: 1,
    content: "",
    tool_call_id: null,
    tool_name: null,
    tool_args: null,
    tool_source: null,
    duration_ms: null,
    llm_request_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const session: SessionDetail = {
  id: "11111111-1111-4111-8111-111111111111",
  api_key_id: null,
  api_key_label: "Lobby kiosk",
  route_slug: "avatar-default",
  agent_id: null,
  agent_version: null,
  status: "active",
  end_reason: null,
  standalone: false,
  started_at: "2026-01-01T00:00:00.000Z",
  last_activity_at: "2026-01-01T00:01:00.000Z",
  ended_at: null,
  turn_count: 1,
  system_prompt_hash: null,
  turns: [
    {
      id: "t1",
      seq: 1,
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: null,
      items: [
        item({ kind: "user_message", content: "Show a cat" }),
        item({ kind: "reasoning", content: "line one\nline two" }),
        item({
          kind: "tool_call",
          tool_name: "show_image",
          tool_source: "client",
          tool_args: { media_id: "cat" },
        }),
        item({ kind: "tool_result", tool_name: "show_image", content: "ok ``` fence" }),
        item({ kind: "assistant_message", content: "Here you go" }),
      ],
      requests: [],
    },
  ],
};

describe("renderSessionMarkdown", () => {
  const markdown = renderSessionMarkdown(session);

  it("renders the header and turn sections", () => {
    expect(markdown).toContain("# Session 11111111-1111-4111-8111-111111111111");
    expect(markdown).toContain("- Client key: Lobby kiosk");
    expect(markdown).toContain("## Turn 1");
  });

  it("renders thinking as a quote and tool calls with source and JSON args", () => {
    expect(markdown).toContain("**Thinking**\n\n> line one\n> line two");
    expect(markdown).toContain("**Tool call** `show_image` (Unity)");
    expect(markdown).toContain('"media_id": "cat"');
  });

  it("uses a longer fence when content contains backticks", () => {
    expect(markdown).toContain("````\nok ``` fence\n````");
  });
});

describe("csvField", () => {
  it("quotes commas and quotes and neutralises formulas", () => {
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvField(null)).toBe("");
    expect(csvField(3)).toBe("3");
  });
});

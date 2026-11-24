import type { SessionDetail, TranscriptItemView } from "@/lib/session-types";

/** Fence long enough that content containing backtick runs cannot close it early. */
function fence(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
}

function codeBlock(content: string, language = ""): string {
  const marks = fence(content);
  return `${marks}${language}\n${content}\n${marks}`;
}

function quote(content: string): string {
  return content
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function sourceLabel(item: TranscriptItemView): string {
  if (item.tool_source === "mcp") return "MCP";
  if (item.tool_source === "builtin") return "Built-in";
  if (item.tool_source === "client") return "Unity";
  return "client";
}

function renderItem(item: TranscriptItemView): string {
  switch (item.kind) {
    case "system_prompt":
      return `**System prompt**\n\n${quote(item.content)}`;
    case "user_message":
      return `**User**\n\n${item.content}`;
    case "assistant_message":
      return `**Assistant**\n\n${item.content}`;
    case "reasoning":
      return `**Thinking**\n\n${quote(item.content)}`;
    case "tool_call":
      return `**Tool call** \`${item.tool_name ?? "unknown"}\` (${sourceLabel(item)})\n\n${codeBlock(
        JSON.stringify(item.tool_args ?? {}, null, 2),
        "json",
      )}`;
    case "tool_result":
      return `**Tool result** \`${item.tool_name ?? item.tool_call_id ?? "unknown"}\`\n\n${codeBlock(item.content)}`;
    case "error":
      return `**Error**\n\n${codeBlock(item.content)}`;
  }
}

/** Readable Markdown transcript with thinking, tool calls and per-turn metadata. */
export function renderSessionMarkdown(session: SessionDetail): string {
  const lines: string[] = [
    `# Session ${session.id}`,
    "",
    `- Status: ${session.status}${session.end_reason ? ` (${session.end_reason})` : ""}`,
    `- Client key: ${session.api_key_label ?? "unknown"}`,
    `- Route: ${session.route_slug ?? "unknown"}`,
    `- Agent: ${session.agent_id ?? "none"}`,
    `- Started: ${session.started_at}`,
    `- Last activity: ${session.last_activity_at}`,
    `- Turns: ${session.turn_count}`,
    "",
  ];

  for (const turn of session.turns) {
    lines.push(`## Turn ${turn.seq}`, "");
    for (const item of turn.items) lines.push(renderItem(item), "");
    for (const request of turn.requests) {
      const parts = [
        `provider ${request.provider_name ?? "none"}`,
        `model ${request.upstream_model ?? "n/a"}`,
        request.duration_ms === null ? undefined : `latency ${request.duration_ms} ms`,
        request.ttft_ms === null ? undefined : `TTFT ${request.ttft_ms} ms`,
        request.usage ? `${request.usage.total_tokens} tokens` : undefined,
        request.attempts.length > 1 ? `${request.attempts.length} attempts` : undefined,
        request.status === "error" ? `error ${request.error_code ?? "unknown"}` : undefined,
      ].filter(Boolean);
      lines.push(`_Request: ${parts.join(", ")}_`, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

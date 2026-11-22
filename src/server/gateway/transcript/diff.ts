import { createHash } from "node:crypto";

export type NewItemKind = "user_message" | "assistant_message" | "tool_call" | "tool_result";

/** A message the client sent that is new to the transcript. */
export interface NewClientItem {
  kind: NewItemKind;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: unknown;
}

export interface HistoryDiff {
  /** Joined system/developer messages, or null when the request has none. */
  systemPrompt: string | null;
  items: NewClientItem[];
  /** True when the new items contain a user message, which opens a new turn. */
  startsTurn: boolean;
}

type Message = Record<string, unknown>;

function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null;
}

/** Flattens OpenAI message content (string or content parts) into text. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isMessage(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (part.type === "image_url") return "[image]";
      if (part.type === "input_audio") return "[audio]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Parses tool-call arguments; invalid JSON is kept as `{ _raw }`. */
export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? null;
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

export function hashSystemPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function isSystemRole(message: Message): boolean {
  return message.role === "system" || message.role === "developer";
}

function toolCallItems(message: Message): NewClientItem[] {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const items: NewClientItem[] = [];
  for (const call of calls) {
    if (!isMessage(call)) continue;
    const fn = isMessage(call.function) ? call.function : {};
    items.push({
      kind: "tool_call",
      content: "",
      toolCallId: typeof call.id === "string" ? call.id : undefined,
      toolName: typeof fn.name === "string" ? fn.name : undefined,
      toolArgs: parseToolArguments(fn.arguments),
    });
  }
  return items;
}

function toItems(message: Message): NewClientItem[] {
  switch (message.role) {
    case "user":
      return [{ kind: "user_message", content: contentToText(message.content) }];
    case "assistant": {
      const text = contentToText(message.content);
      const items: NewClientItem[] = text ? [{ kind: "assistant_message", content: text }] : [];
      return [...items, ...toolCallItems(message)];
    }
    case "tool":
      return [
        {
          kind: "tool_result",
          content: contentToText(message.content),
          toolCallId: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
        },
      ];
    default:
      return [];
  }
}

/**
 * The client resends the full history on every request. For a session that already has
 * transcript content, the new items are the messages after the last `assistant` message;
 * for the first request they are all non-system messages.
 */
export function diffNewItems(messages: unknown[], isFirstRequest: boolean): HistoryDiff {
  const all = messages.filter(isMessage);
  const system = all.filter(isSystemRole).map((message) => contentToText(message.content));
  const conversation = all.filter((message) => !isSystemRole(message));

  const lastAssistant = conversation.map((message) => message.role).lastIndexOf("assistant");
  const startIndex = isFirstRequest ? 0 : lastAssistant + 1;
  const items = conversation.slice(startIndex).flatMap(toItems);

  return {
    systemPrompt: system.length > 0 ? system.join("\n\n") : null,
    items,
    startsTurn: items.some((item) => item.kind === "user_message"),
  };
}

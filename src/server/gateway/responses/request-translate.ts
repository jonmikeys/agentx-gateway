/**
 * Responses API request -> Chat Completions request.
 *
 * The gateway's canonical format is chat completions. `normalizeResponsesInput` produces the chat
 * messages (also used for transcript capture, whichever API the upstream speaks) and
 * `buildChatRequest` produces the rest of the chat body for steps that need translation.
 */

export type ChatMessage = Record<string, unknown>;
type Json = Record<string, unknown>;

/** A request the gateway refuses to translate; becomes an HTTP 400 with an OpenAI error body. */
export class TranslationError extends Error {
  readonly status = 400 as const;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TranslationError";
  }
}

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: Json };

function imagePart(part: Json): ChatPart {
  const raw = part.image_url;
  const url = typeof raw === "string" ? raw : asObject(raw)?.url;
  if (!isNonEmptyString(url)) {
    throw new TranslationError(
      "unsupported_input",
      "input_image parts need an image_url; file_id images are not supported by the gateway.",
    );
  }
  const detail = typeof part.detail === "string" ? part.detail : asObject(raw)?.detail;
  const image: Json = { url };
  if (typeof detail === "string" && detail !== "auto") image.detail = detail;
  return { type: "image_url", image_url: image };
}

function convertParts(parts: unknown[]): ChatPart[] {
  const result: ChatPart[] = [];
  for (const raw of parts) {
    if (typeof raw === "string") {
      result.push({ type: "text", text: raw });
      continue;
    }
    const part = asObject(raw);
    if (!part) continue;
    switch (part.type) {
      case "input_text":
      case "output_text":
      case "text":
        if (typeof part.text === "string") result.push({ type: "text", text: part.text });
        break;
      case "refusal":
        if (typeof part.refusal === "string") result.push({ type: "text", text: part.refusal });
        break;
      case "input_image":
        result.push(imagePart(part));
        break;
      case "input_file":
      case "input_audio":
        throw new TranslationError(
          "unsupported_input",
          `Content part type "${String(part.type)}" is not supported by the gateway.`,
        );
      default:
        // Unknown part types are dropped when translating.
        break;
    }
  }
  return result;
}

/** String content stays a string; images keep a parts array (user messages only). */
function convertContent(role: string, content: unknown): string | ChatPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = convertParts(content);
  const hasImage = parts.some((part) => part.type === "image_url");
  if (hasImage && role === "user") return parts;
  return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  return JSON.stringify(output);
}

function argumentsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  return JSON.stringify(value);
}

function chatRole(role: unknown): string | undefined {
  switch (role) {
    case "user":
    case "assistant":
    case "system":
      return role;
    // Not every OpenAI-compatible upstream knows the developer role.
    case "developer":
      return "system";
    default:
      return undefined;
  }
}

function appendFunctionCall(messages: ChatMessage[], item: Json): void {
  const callId = isNonEmptyString(item.call_id) ? item.call_id : item.id;
  if (!isNonEmptyString(callId) || !isNonEmptyString(item.name)) {
    throw new TranslationError("invalid_request", "function_call items need a call_id and a name.");
  }
  const toolCall = {
    id: callId,
    type: "function",
    function: { name: item.name, arguments: argumentsText(item.arguments) },
  };
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    // One model reply (text and calls) is a single assistant message in chat format.
    const calls = Array.isArray(last.tool_calls) ? (last.tool_calls as unknown[]) : [];
    last.tool_calls = [...calls, toolCall];
    return;
  }
  messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
}

/** Converts `instructions` and `input` into chat messages. */
export function normalizeResponsesInput(body: Json): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (isNonEmptyString(body.instructions)) {
    messages.push({ role: "system", content: body.instructions });
  }

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) {
    throw new TranslationError("invalid_request", "input must be a string or an array of items.");
  }

  for (const raw of input) {
    const item = asObject(raw);
    if (!item) continue;
    const type = typeof item.type === "string" ? item.type : "message";
    switch (type) {
      case "message": {
        const role = chatRole(item.role);
        if (!role) {
          throw new TranslationError(
            "invalid_request",
            `Unsupported message role "${String(item.role)}".`,
          );
        }
        messages.push({ role, content: convertContent(role, item.content) });
        break;
      }
      case "function_call":
        appendFunctionCall(messages, item);
        break;
      case "function_call_output": {
        if (!isNonEmptyString(item.call_id)) {
          throw new TranslationError("invalid_request", "function_call_output needs a call_id.");
        }
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: toolOutputText(item.output),
        });
        break;
      }
      case "item_reference":
        throw new TranslationError(
          "unsupported_parameter",
          "item_reference is not supported: the gateway is stateless for Responses, send the full input.",
        );
      default:
        // reasoning items and other output items have no chat equivalent and are dropped.
        break;
    }
  }
  return messages;
}

function convertTools(tools: unknown): unknown[] | undefined {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) {
    throw new TranslationError("invalid_request", "tools must be an array.");
  }
  if (tools.length === 0) return undefined;
  return tools.map((raw) => {
    const tool = asObject(raw);
    if (!tool || tool.type !== "function") {
      throw new TranslationError(
        "unsupported_tool",
        `Tool type "${String(tool?.type)}" is not supported for translated Responses requests: only function tools can be converted to chat completions.`,
      );
    }
    if (!isNonEmptyString(tool.name)) {
      throw new TranslationError("invalid_request", "Function tools need a name.");
    }
    const fn: Json = { name: tool.name };
    if (tool.description !== undefined) fn.description = tool.description;
    if (tool.parameters !== undefined) fn.parameters = tool.parameters;
    if (tool.strict !== undefined) fn.strict = tool.strict;
    return { type: "function", function: fn };
  });
}

function convertToolChoice(choice: unknown): unknown {
  if (choice === undefined || choice === null) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  const object = asObject(choice);
  if (object?.type === "function" && isNonEmptyString(object.name)) {
    return { type: "function", function: { name: object.name } };
  }
  throw new TranslationError(
    "unsupported_tool",
    "tool_choice must be auto, none, required or {type:'function', name} for translated requests.",
  );
}

/** Chat request body (without `model` and `stream`, which the proxy sets per step). */
export function buildChatRequest(body: Json, messages: ChatMessage[]): Json {
  const chat: Json = { messages };
  for (const field of ["temperature", "top_p", "parallel_tool_calls", "user"]) {
    if (body[field] !== undefined && body[field] !== null) chat[field] = body[field];
  }
  if (typeof body.max_output_tokens === "number") chat.max_tokens = body.max_output_tokens;
  const effort = asObject(body.reasoning)?.effort;
  if (typeof effort === "string") chat.reasoning_effort = effort;

  const tools = convertTools(body.tools);
  if (tools) {
    chat.tools = tools;
    const toolChoice = convertToolChoice(body.tool_choice);
    if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  }
  return chat;
}

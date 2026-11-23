/**
 * Emulates the AGENTX Unity Responses consumer (`ResponsesApiAdapter.cs`,
 * `ReadStreamingRoundAsync` + `ResponsesStreamAccumulator`) and records which fields it reads.
 * Used by the contract tests: a stream that this parser accepts is one Unity can consume.
 *
 * Rules mirrored from the C# code:
 *  - every `data:` payload is parsed as JSON (`JObject.Parse`), so a `[DONE]` sentinel would throw;
 *  - the event name is the `event:` line or else `type`;
 *  - `response.output_text.delta` -> `delta`; `response.reasoning_summary_text.delta` -> `delta`;
 *    `response.output_item.done` -> `item`; `response.completed` -> `response.output` (authoritative);
 *  - `response.failed`, `response.incomplete` and `error` throw.
 */
type Json = Record<string, unknown>;

export interface UnityRound {
  text: string;
  reasoning: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  /** `type` values of every event the parser handled, in order. */
  eventTypes: string[];
}

/** The request body Unity's `ResponsesApiTurn.BuildRequestBody` produces for a tool-enabled turn. */
export function unityRequestBody(model: string | undefined, stream: boolean): Json {
  const body: Json = {
    input: [
      { role: "system", content: "You are Aiko.\n\nUse the tools to show media." },
      { role: "user", content: "Show me a sunset photo, please." },
    ],
    stream,
    store: false,
    include: ["reasoning.encrypted_content"],
    temperature: 0.7,
    tools: [
      {
        type: "function",
        name: "show_image",
        description: "Shows an image on screen",
        parameters: {
          type: "object",
          properties: { media_id: { type: "string" } },
          required: ["media_id"],
        },
      },
    ],
    tool_choice: "auto",
    reasoning: { effort: "medium", summary: "auto" },
  };
  if (model !== undefined) body.model = model;
  return body;
}

/** The follow-up request after a tool round: output items echoed verbatim, then the result. */
export function unityToolRoundBody(model: string, echoedOutput: Json[], stream: boolean): Json {
  const base = unityRequestBody(model, stream) as { input: Json[] };
  return {
    ...base,
    input: [
      ...base.input,
      ...echoedOutput,
      { type: "function_call_output", call_id: "call_mock_1", output: '{"shown":true}' },
    ],
  };
}

function outputText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  let text = "";
  for (const item of output as Json[]) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Json[]) {
      if (part.type === "output_text") text += String(part.text ?? "");
      else if (part.type === "refusal") text += String(part.refusal ?? "");
    }
  }
  return text;
}

function buildRound(output: unknown, text: string, eventTypes: string[], reasoning: string) {
  const toolCalls: UnityRound["toolCalls"] = [];
  if (Array.isArray(output)) {
    for (const item of output as Json[]) {
      if (item.type !== "function_call") continue;
      const args = item.arguments;
      toolCalls.push({
        id: String(item.call_id ?? ""),
        name: String(item.name ?? ""),
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      });
    }
  }
  return { text, reasoning, toolCalls, eventTypes } satisfies UnityRound;
}

/** Parses a complete Responses SSE body the way `ReadStreamingRoundAsync` does. */
export function readUnityStream(body: string): UnityRound {
  let content = "";
  let reasoning = "";
  const doneItems: Json[] = [];
  let authoritative: unknown;
  const eventTypes: string[] = [];

  const handle = (eventName: string | null, data: string[]) => {
    if (data.length === 0) return;
    const json = JSON.parse(data.join("\n")) as Json; // JObject.Parse: throws on [DONE]
    const name = eventName || (typeof json.type === "string" ? json.type : "");
    if (!name) return;
    eventTypes.push(name);
    switch (name) {
      case "response.output_text.delta":
        content += String(json.delta ?? "");
        break;
      case "response.reasoning_summary_text.delta":
        reasoning += String(json.delta ?? "");
        break;
      case "response.output_item.done":
        if (json.item) doneItems.push(json.item as Json);
        break;
      case "response.completed":
        authoritative = (json.response as Json | undefined)?.output;
        break;
      case "response.failed":
      case "response.incomplete":
      case "error":
        throw new Error(`OpenAI Responses stream failed: ${JSON.stringify(json)}`);
      default:
        break;
    }
  };

  let eventName: string | null = null;
  let data: string[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
    else if (line.length === 0) {
      handle(eventName, data);
      eventName = null;
      data = [];
    }
  }
  handle(eventName, data);

  const output = authoritative ?? (doneItems.length > 0 ? doneItems : undefined);
  return buildRound(
    output,
    content.length > 0 ? content : outputText(output),
    eventTypes,
    reasoning,
  );
}

/** Parses a complete (non-stream) Responses JSON body the way `ReadCompletionRound` does. */
export function readUnityJson(body: string): UnityRound {
  const root = JSON.parse(body) as Json;
  const status = root.status;
  if (
    (root.error !== undefined && root.error !== null) ||
    status === "failed" ||
    status === "incomplete"
  ) {
    throw new Error(`OpenAI Responses response was ${String(status)}`);
  }
  return buildRound(root.output, outputText(root.output), [], "");
}

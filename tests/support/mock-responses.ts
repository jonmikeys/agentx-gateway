import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Native Responses API behaviour of the mock upstream (`POST /responses`). The upstream model
 * picks the switch, exactly like `/chat/completions`: fail-*, bad-request-*, slow, empty-stream,
 * midstream-fail, reasoning, tool-call, echo. Anything else (including think-tags) answers
 * "Hello there". Self-contained so Playwright and tsx can load it.
 */
type Json = Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

/** Text of the last user message in a Responses `input` (string or item array). */
function lastUserText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  for (const item of [...input].reverse() as Json[]) {
    if (item.role !== "user") continue;
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) {
      return (item.content as Json[]).map((part) => String(part.text ?? "")).join("");
    }
  }
  return "";
}

interface Plan {
  reasoning: string;
  text: string;
  textChunks: string[];
  call?: { name: string; arguments: string };
}

function planFor(model: string, input: unknown): Plan {
  const last = Array.isArray(input) ? (input.at(-1) as Json | undefined) : undefined;
  const afterTool = last?.type === "function_call_output";
  switch (model) {
    case "reasoning":
      return {
        reasoning: "The user greets me. I should answer warmly.",
        text: "Hello from the reasoning model.",
        textChunks: ["Hello ", "from the reasoning model."],
      };
    case "tool-call":
      if (afterTool) {
        return {
          reasoning: "",
          text: "Done! I put the image on screen.",
          textChunks: ["Done! ", "I put the image on screen."],
        };
      }
      return {
        reasoning: "",
        text: "Let me show that.",
        textChunks: ["Let me show that."],
        call: { name: "show_image", arguments: '{"media_id":"sunset"}' },
      };
    case "echo": {
      const user = lastUserText(input);
      return { reasoning: "", text: `Echo: ${user}`, textChunks: ["Echo: ", user] };
    }
    default:
      return { reasoning: "", text: "Hello there", textChunks: ["Hel", "lo ", "there"] };
  }
}

function buildOutput(plan: Plan): Json[] {
  const output: Json[] = [];
  if (plan.reasoning) {
    output.push({
      id: "rs_mock",
      type: "reasoning",
      summary: [{ type: "summary_text", text: plan.reasoning }],
    });
  }
  output.push({
    id: "msg_mock",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: plan.text, annotations: [] }],
  });
  if (plan.call) {
    output.push({
      id: "fc_mock",
      type: "function_call",
      status: "completed",
      call_id: "call_mock_1",
      name: plan.call.name,
      arguments: plan.call.arguments,
    });
  }
  return output;
}

export async function handleResponses(
  request: IncomingMessage,
  response: ServerResponse,
  body: Json | undefined,
  slowMs: number,
  sendError: (response: ServerResponse, status: number, message: string) => void,
): Promise<void> {
  const model = String(body?.model ?? "ok");
  const failure = /^(fail|bad-request)-(\d{3})$/.exec(model);
  if (failure) {
    sendError(response, Number(failure[2]), `Mock ${model}`);
    return;
  }
  if (model === "slow") await sleep(slowMs);
  if (model === "empty-stream") {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end();
    return;
  }

  const plan = planFor(model, body?.input);
  const usage = { input_tokens: 5, output_tokens: 3, total_tokens: 8 };
  const output = buildOutput(plan);
  const full = {
    id: "resp_mock",
    object: "response",
    created_at: 1,
    status: "completed",
    model,
    output,
    usage,
  };

  if (body?.stream !== true) {
    sendJson(response, 200, full);
    return;
  }

  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  let sequence = 0;
  const send = (type: string, payload: Json) => {
    const data = JSON.stringify({ type, sequence_number: sequence, ...payload });
    response.write(`event: ${type}\ndata: ${data}\n\n`);
    sequence += 1;
  };
  const started = { ...full, status: "in_progress", output: [], usage: null };
  send("response.created", { response: started });
  send("response.in_progress", { response: started });
  await sleep(10);

  let index = 0;
  if (plan.reasoning) {
    send("response.output_item.added", {
      output_index: index,
      item: { id: "rs_mock", type: "reasoning", summary: [] },
    });
    send("response.reasoning_summary_text.delta", {
      item_id: "rs_mock",
      output_index: index,
      summary_index: 0,
      delta: plan.reasoning,
    });
    send("response.reasoning_summary_text.done", {
      item_id: "rs_mock",
      output_index: index,
      summary_index: 0,
      text: plan.reasoning,
    });
    send("response.output_item.done", { output_index: index, item: output[index] });
    index += 1;
  }

  send("response.output_item.added", {
    output_index: index,
    item: {
      id: "msg_mock",
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    },
  });
  send("response.content_part.added", {
    item_id: "msg_mock",
    output_index: index,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  for (const piece of plan.textChunks) {
    send("response.output_text.delta", {
      item_id: "msg_mock",
      output_index: index,
      content_index: 0,
      delta: piece,
    });
    await sleep(10);
    if (model === "midstream-fail") {
      request.socket.destroy();
      return;
    }
  }
  send("response.output_text.done", {
    item_id: "msg_mock",
    output_index: index,
    content_index: 0,
    text: plan.text,
  });
  send("response.output_item.done", { output_index: index, item: output[index] });
  index += 1;

  if (plan.call) {
    send("response.output_item.added", {
      output_index: index,
      item: {
        id: "fc_mock",
        type: "function_call",
        status: "in_progress",
        call_id: "call_mock_1",
        name: plan.call.name,
        arguments: "",
      },
    });
    const half = Math.floor(plan.call.arguments.length / 2);
    for (const piece of [plan.call.arguments.slice(0, half), plan.call.arguments.slice(half)]) {
      send("response.function_call_arguments.delta", {
        item_id: "fc_mock",
        output_index: index,
        delta: piece,
      });
    }
    send("response.function_call_arguments.done", {
      item_id: "fc_mock",
      output_index: index,
      arguments: plan.call.arguments,
    });
    send("response.output_item.done", { output_index: index, item: output[index] });
  }
  send("response.completed", { response: full });
  response.end();
}

import { z } from "zod";

/**
 * Chatflow graph model (docs/agents.md). A flow is React Flow JSON: nodes carry a Zod-validated
 * `data` payload, edges connect node handles. This module is shared by the server (validation,
 * compilation) and the CRM editor (forms, palette, handles), so it must stay free of server
 * imports.
 */

export const NODE_TYPES = [
  "start",
  "llm",
  "router",
  "set_variable",
  "webhook",
  "memory",
  "mcp_tool",
  "client_action",
  "reply",
  "end",
  "subflow_input",
  "subflow_output",
  "call_subflow",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export type FlowKind = "agent" | "subflow";

export const nodeTypeSchema = z.enum(NODE_TYPES);
export const flowKindSchema = z.enum(["agent", "subflow"]);

const positionSchema = z.object({ x: z.number(), y: z.number() });

const variableNameSchema = z
  .string()
  .trim()
  .min(1, "Variable name is required")
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use letters, digits and underscores, starting with a letter");

/** Fields every node shares. `comment` is the G7b node comment; kept here so it travels with graphs. */
const common = {
  title: z.string().trim().min(1, "Title is required").max(120),
  comment: z.string().max(4000).optional(),
};

const templateString = (max: number) => z.string().max(max).default("");

export const llmNodeDataSchema = z.object({
  ...common,
  /** `inherit` uses the request route (or the agent's default route). */
  model: z.string().trim().min(1, "Choose a model route or inherit").max(120),
  systemPrompt: templateString(20_000),
  history: z.enum(["full", "last_n", "none"]).default("full"),
  historyLimit: z.coerce.number().int().min(1).max(100).default(10),
  /** Allowed MCP tool ids offered to this node (a subset of the registry). */
  mcpToolIds: z.array(z.uuid()).max(50).default([]),
  /** Which of the client's request tools this node offers (spec §13, Unity tools inside agents). */
  clientTools: z
    .object({
      mode: z.enum(["none", "all", "subset"]).default("none"),
      names: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
    })
    .default({ mode: "none", names: [] }),
  outputVariable: variableNameSchema.default("llm_output"),
  /** Stream to the client when the node is terminal; non-terminal nodes still collect the text. */
  stream: z.boolean().default(true),
});

export const routerRuleSchema = z.object({
  /** Stable handle id; the editor generates one. */
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1, "Label is required").max(60),
  operator: z.enum(["equals", "contains", "regex"]).default("contains"),
  /** The template text the value is matched against, usually `{{input.text}}`. */
  subject: templateString(2000).default("{{input.text}}"),
  /** Rendered as a template before matching. */
  value: z.string().max(2000).default(""),
});

export const routerNodeDataSchema = z
  .object({
    ...common,
    mode: z.enum(["rules", "intent"]).default("rules"),
    /** Route used to pick an intent label; `inherit` follows the agent/request route. */
    model: z.string().trim().min(1).max(120).default("inherit"),
    /** One output handle per rule, matched in order. */
    rules: z.array(routerRuleSchema).max(8).default([]),
    /** One output handle per label; an LLM picks it. */
    intentLabels: z.array(z.string().trim().min(1).max(60)).max(8).default([]),
    intentInstruction: templateString(4000),
    defaultLabel: z.string().trim().min(1).max(60).default("default"),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "rules" && value.rules.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["rules"],
        message: "Add at least one rule",
      });
    }
    if (value.mode === "intent" && value.intentLabels.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["intentLabels"],
        message: "Add at least one intent label",
      });
    }
    const labels =
      value.mode === "intent" ? value.intentLabels : value.rules.map((rule) => rule.label);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: "custom", path: ["rules"], message: "Labels must be unique" });
    }
  });

export const setVariableNodeDataSchema = z.object({
  ...common,
  assignments: z
    .array(z.object({ key: variableNameSchema, value: templateString(4000) }))
    .max(20)
    .default([]),
});

export const webhookHeaderSchema = z.object({
  name: z.string().trim().min(1, "Header name is required").max(100),
  /** Write-only; never stored in the graph. The value lives in `flow_webhook_secrets`. */
  value: z.string().max(4000).optional(),
  /** Masked display value returned by the admin API. */
  masked: z.string().max(120).optional(),
});

export const webhookMappingSchema = z.object({
  variable: variableNameSchema,
  /** Dotted JSON path into the response body, for example `data.items.0.name`. */
  path: z.string().trim().min(1).max(200),
});

export const webhookNodeDataSchema = z.object({
  ...common,
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  url: z.string().trim().min(1, "URL is required").max(2000),
  headers: z.array(webhookHeaderSchema).max(20).default([]),
  bodyTemplate: templateString(20_000),
  timeoutMs: z.coerce.number().int().min(500).max(60_000).default(10_000),
  retries: z.coerce.number().int().min(0).max(3).default(0),
  maxResponseBytes: z.coerce.number().int().min(1024).max(5_000_000).default(65_536),
  mappings: z.array(webhookMappingSchema).max(20).default([]),
  outputVariable: variableNameSchema.default("webhook"),
});

export const memoryNodeDataSchema = z.object({
  ...common,
  operation: z.enum(["get", "set", "append", "delete"]).default("get"),
  /** Rendered as a template, so `{{vars.key}}` can select a memory key. */
  key: z.string().trim().min(1, "Key is required").max(200),
  value: templateString(20_000),
  outputVariable: variableNameSchema.default("memory_value"),
});

export const mcpToolNodeDataSchema = z.object({
  ...common,
  serverId: z.uuid("Choose an MCP server"),
  toolName: z.string().trim().min(1, "Choose a tool").max(120),
  args: z
    .array(z.object({ name: z.string().trim().min(1).max(120), value: templateString(4000) }))
    .max(30)
    .default([]),
  outputVariable: variableNameSchema.default("mcp_output"),
});

/** Client Action: emits one fixed Unity tool call with no LLM, then pauses for the result. */
export const clientActionNodeDataSchema = z.object({
  ...common,
  toolName: z.string().trim().min(1, "Choose a client tool").max(120).default("show_image"),
  /** JSON object template; `{{…}}` paths are interpolated before parsing. */
  argsTemplate: z.string().max(8000).default("{}"),
  outputVariable: variableNameSchema.default("client_result"),
});

export const replyNodeDataSchema = z.object({
  ...common,
  template: z.string().min(1, "Reply text is required").max(20_000),
});

export const startNodeDataSchema = z.object({ ...common });
export const endNodeDataSchema = z.object({ ...common });

export const SUBFLOW_PARAM_TYPES = ["string", "number", "boolean", "json"] as const;
export type SubflowParamType = (typeof SUBFLOW_PARAM_TYPES)[number];

/** One declared subflow input parameter. */
export const subflowParamSchema = z.object({
  name: variableNameSchema,
  type: z.enum(SUBFLOW_PARAM_TYPES).default("string"),
  required: z.boolean().default(true),
});

export const subflowInputNodeDataSchema = z.object({
  ...common,
  params: z.array(subflowParamSchema).max(50).default([]),
});

/** One declared return value of a subflow output; `value` is rendered as a template. */
export const subflowReturnSchema = z.object({
  name: variableNameSchema,
  value: templateString(20_000),
});

export const subflowOutputNodeDataSchema = z.object({
  ...common,
  /** The branch label the caller sees; unique per subflow. */
  label: z.string().trim().min(1, "Label is required").max(60).default("result"),
  values: z.array(subflowReturnSchema).max(20).default([]),
});

/** Mapping of one declared subflow parameter to a caller template. */
export const subflowInputMappingSchema = z.object({
  name: variableNameSchema,
  value: templateString(4000).default(""),
});

/** Where one subflow output label's return value lands in the caller's vars. */
export const subflowOutputMappingSchema = z.object({
  label: z.string().trim().min(1).max(60),
  variable: variableNameSchema,
});

export const callSubflowNodeDataSchema = z.object({
  ...common,
  /** Target flow id (`agt_…`); must be a published subflow at publish time. */
  subflowId: z.string().trim().max(80).nullable().default(null),
  /** Display name captured by the editor for the card; refreshed when the target changes. */
  subflowName: z.string().trim().max(120).optional(),
  inputs: z.array(subflowInputMappingSchema).max(50).default([]),
  /** One output handle per entry (`out:<label>`); the handle carries the branch. */
  outputs: z.array(subflowOutputMappingSchema).max(20).default([]),
});

const nodeBase = {
  id: z.string().trim().min(1).max(80),
  position: positionSchema,
};

export const flowNodeSchema = z.discriminatedUnion("type", [
  z.object({ ...nodeBase, type: z.literal("start"), data: startNodeDataSchema }),
  z.object({ ...nodeBase, type: z.literal("llm"), data: llmNodeDataSchema }),
  z.object({ ...nodeBase, type: z.literal("router"), data: routerNodeDataSchema }),
  z.object({ ...nodeBase, type: z.literal("set_variable"), data: setVariableNodeDataSchema }),
  z.object({ ...nodeBase, type: z.literal("webhook"), data: webhookNodeDataSchema }),
  z.object({ ...nodeBase, type: z.literal("memory"), data: memoryNodeDataSchema }),
  z.object({ ...nodeBase, type: z.literal("mcp_tool"), data: mcpToolNodeDataSchema }),
  z.object({ ...nodeBase, type: z.literal("client_action"), data: clientActionNodeDataSchema }),
  z.object({ ...nodeBase, type: z.literal("reply"), data: replyNodeDataSchema }),
  z.object({ ...nodeBase, type: z.literal("end"), data: endNodeDataSchema }),
  z.object({ ...nodeBase, type: z.literal("subflow_input"), data: subflowInputNodeDataSchema }),
  z.object({ ...nodeBase, type: z.literal("subflow_output"), data: subflowOutputNodeDataSchema }),
  z.object({ ...nodeBase, type: z.literal("call_subflow"), data: callSubflowNodeDataSchema }),
]);

export const flowEdgeSchema = z.looseObject({
  id: z.string().trim().min(1).max(120),
  source: z.string().trim().min(1).max(80),
  target: z.string().trim().min(1).max(80),
  sourceHandle: z.string().nullish(),
  targetHandle: z.string().nullish(),
  label: z.string().max(120).optional(),
  /** `loop: true` opts a cycle into the validator's "cycles must be loops" rule. */
  data: z.object({ loop: z.boolean().optional() }).optional(),
});

export const flowGraphSchema = z.object({
  nodes: z.array(flowNodeSchema).max(200),
  edges: z.array(flowEdgeSchema).max(400),
});

export type FlowNode = z.infer<typeof flowNodeSchema>;
export type FlowNodeData = FlowNode["data"];
export type FlowEdge = z.infer<typeof flowEdgeSchema>;
export type FlowGraph = z.infer<typeof flowGraphSchema>;
export type LlmNodeData = z.infer<typeof llmNodeDataSchema>;
export type RouterNodeData = z.infer<typeof routerNodeDataSchema>;
export type WebhookNodeData = z.infer<typeof webhookNodeDataSchema>;
export type SetVariableNodeData = z.infer<typeof setVariableNodeDataSchema>;
export type MemoryNodeData = z.infer<typeof memoryNodeDataSchema>;
export type McpToolNodeData = z.infer<typeof mcpToolNodeDataSchema>;
export type ClientActionNodeData = z.infer<typeof clientActionNodeDataSchema>;
export type ReplyNodeData = z.infer<typeof replyNodeDataSchema>;
export type SubflowInputNodeData = z.infer<typeof subflowInputNodeDataSchema>;
export type SubflowOutputNodeData = z.infer<typeof subflowOutputNodeDataSchema>;
export type CallSubflowNodeData = z.infer<typeof callSubflowNodeDataSchema>;
export type SubflowParam = z.infer<typeof subflowParamSchema>;

/** Node types whose execution can fail and that therefore expose an `error` output handle. */
export function isFallibleNode(type: NodeType): boolean {
  return (
    type === "llm" ||
    type === "router" ||
    type === "webhook" ||
    type === "mcp_tool" ||
    type === "client_action" ||
    type === "call_subflow"
  );
}

/** One labelled output handle of a node; `id` is what edges use as `sourceHandle`. */
export interface NodeHandle {
  id: string;
  label: string;
  kind: "out" | "error" | "route";
}

/** The output handles a node offers (used by the canvas and the validator). */
export function nodeHandles(node: FlowNode): NodeHandle[] {
  switch (node.type) {
    case "router": {
      const data = node.data;
      if (data.mode === "intent") {
        return [
          ...data.intentLabels.map((label) => ({
            id: `intent:${label}`,
            label,
            kind: "route" as const,
          })),
          { id: "default", label: data.defaultLabel, kind: "route" as const },
          ...(isFallibleNode("router")
            ? [{ id: "error", label: "error", kind: "error" as const }]
            : []),
        ];
      }
      return [
        ...data.rules.map((rule) => ({ id: rule.id, label: rule.label, kind: "route" as const })),
        { id: "default", label: "default", kind: "route" as const },
        ...(isFallibleNode("router")
          ? [{ id: "error", label: "error", kind: "error" as const }]
          : []),
      ];
    }
    case "call_subflow": {
      return [
        ...node.data.outputs.map((output) => ({
          id: `out:${output.label}`,
          label: output.label,
          kind: "out" as const,
        })),
        ...(isFallibleNode("call_subflow")
          ? [{ id: "error", label: "error", kind: "error" as const }]
          : []),
      ];
    }
    case "subflow_output":
      return [];
    case "end":
      return [];
    default:
      return isFallibleNode(node.type)
        ? [
            { id: "out", label: "output", kind: "out" },
            { id: "error", label: "error", kind: "error" },
          ]
        : [{ id: "out", label: "output", kind: "out" }];
  }
}

/** The handle id a node targets by default (its first non-error output). */
export function defaultSourceHandle(node: FlowNode): string | undefined {
  return nodeHandles(node).find((handle) => handle.kind !== "error")?.id;
}

export interface NodeCatalogEntry {
  type: NodeType;
  label: string;
  group: "Flow" | "AI" | "Actions" | "Data";
  description: string;
  defaultData: () => FlowNodeData;
  /** Flow kinds that offer the node in the palette; omitted means both. */
  kinds?: readonly FlowKind[];
}

/** Palette entries and the default data used when a node is added. */
export const nodeCatalog: NodeCatalogEntry[] = [
  {
    type: "start",
    label: "Start",
    group: "Flow",
    description: "Entry point; exposes the user message, history and session id.",
    defaultData: () => ({ title: "Start" }),
    kinds: ["agent"],
  },
  {
    type: "reply",
    label: "Reply",
    group: "Flow",
    description: "Streams templated text to the client.",
    defaultData: () => ({ title: "Reply", template: "Hello from the agent." }),
  },
  {
    type: "end",
    label: "End",
    group: "Flow",
    description: "Ends the turn.",
    defaultData: () => ({ title: "End" }),
    kinds: ["agent"],
  },
  {
    type: "subflow_input",
    label: "Subflow Input",
    group: "Flow",
    description: "Declares the typed parameters a caller must pass in. Exactly one per subflow.",
    defaultData: () => ({ title: "Input", params: [] }),
    kinds: ["subflow"],
  },
  {
    type: "subflow_output",
    label: "Subflow Output",
    group: "Flow",
    description: "Declares return values and a branch label. Add one per caller branch.",
    defaultData: () => ({ title: "Output", label: "result", values: [] }),
    kinds: ["subflow"],
  },
  {
    type: "llm",
    label: "LLM",
    group: "AI",
    description: "Calls a model route with a prompt and conversation history.",
    defaultData: () => ({
      title: "LLM",
      model: "inherit",
      systemPrompt: "",
      history: "full",
      historyLimit: 10,
      mcpToolIds: [],
      clientTools: { mode: "none", names: [] },
      outputVariable: "llm_output",
      stream: true,
    }),
  },
  {
    type: "router",
    label: "Router",
    group: "AI",
    description: "Branches on rules or picks an intent label with an LLM.",
    defaultData: () => ({
      title: "Router",
      mode: "rules",
      model: "inherit",
      rules: [
        {
          id: "rule_1",
          label: "Match",
          operator: "contains",
          subject: "{{input.text}}",
          value: "",
        },
      ],
      intentLabels: [],
      intentInstruction:
        "Pick the label that best matches the user message. Answer with the label only.",
      defaultLabel: "default",
    }),
  },
  {
    type: "webhook",
    label: "Webhook",
    group: "Actions",
    description: "Calls an HTTP endpoint and maps the JSON response into variables.",
    defaultData: () => ({
      title: "Webhook",
      method: "POST",
      url: "",
      headers: [],
      bodyTemplate: "",
      timeoutMs: 10_000,
      retries: 0,
      maxResponseBytes: 65_536,
      mappings: [],
      outputVariable: "webhook",
    }),
  },
  {
    type: "mcp_tool",
    label: "MCP Tool",
    group: "Actions",
    description: "Calls one allowed tool on a registered MCP server.",
    defaultData: () => ({
      title: "MCP Tool",
      serverId: "",
      toolName: "",
      args: [],
      outputVariable: "mcp_output",
    }),
  },
  {
    type: "client_action",
    label: "Client Action",
    group: "Actions",
    description:
      "Emits a Unity tool call (show media, camera, animation) and waits for its result.",
    defaultData: () => ({
      title: "Client Action",
      toolName: "show_image",
      argsTemplate: '{\n  "media_id": ""\n}',
      outputVariable: "client_result",
    }),
  },
  {
    type: "call_subflow",
    label: "Call Subflow",
    group: "Actions",
    description: "Runs a published subflow with mapped inputs; each output label is a branch.",
    defaultData: () => ({
      title: "Call subflow",
      subflowId: null,
      inputs: [],
      outputs: [],
    }),
  },
  {
    type: "set_variable",
    label: "Set Variable",
    group: "Data",
    description: "Assigns variables from templates.",
    defaultData: () => ({ title: "Set variable", assignments: [] }),
  },
  {
    type: "memory",
    label: "Memory",
    group: "Data",
    description: "Reads or writes session memory.",
    defaultData: () => ({
      title: "Memory",
      operation: "get",
      key: "key",
      value: "",
      outputVariable: "memory_value",
    }),
  },
];

export function catalogFor(type: NodeType): NodeCatalogEntry | undefined {
  return nodeCatalog.find((entry) => entry.type === type);
}

let nodeCounter = 0;

/** Fresh React Flow node of the given type with defaults from the catalog. */
export function createFlowNode(
  type: NodeType,
  position: { x: number; y: number },
  overrides: Partial<FlowNodeData> = {},
): FlowNode {
  const entry = catalogFor(type);
  if (!entry) throw new Error(`Unknown node type ${type}`);
  nodeCounter += 1;
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}${nodeCounter}`;
  return {
    id: `${type}_${suffix}`,
    type,
    position,
    data: { ...entry.defaultData(), ...overrides },
  } as FlowNode;
}

export const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [] };

/** A freshly created agent starts with a valid skeleton: Start -> Reply -> End. */
export function starterGraph(kind: FlowKind = "agent"): FlowGraph {
  if (kind === "subflow") {
    const input = createFlowNode("subflow_input", { x: 0, y: 0 });
    const output = createFlowNode("subflow_output", { x: 320, y: 0 });
    return {
      nodes: [input, output],
      edges: [{ id: "e_input_output", source: input.id, target: output.id, sourceHandle: "out" }],
    };
  }
  const start = createFlowNode("start", { x: 0, y: 0 });
  const reply = createFlowNode("reply", { x: 260, y: 0 });
  const end = createFlowNode("end", { x: 520, y: 0 });
  return {
    nodes: [start, reply, end],
    edges: [
      { id: "e_start_reply", source: start.id, target: reply.id, sourceHandle: "out" },
      { id: "e_reply_end", source: reply.id, target: end.id, sourceHandle: "out" },
    ],
  };
}

/** Edge handle id used for one Call Subflow output branch. */
export function subflowOutputHandle(label: string): string {
  return `out:${label}`;
}

/** `1 label`, `2 labels` for compact UI counts. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Short human summary of a node for its card. */
export function summarizeNode(node: FlowNode): string {
  switch (node.type) {
    case "start":
      return "Entry point";
    case "llm": {
      const model = node.data.model === "inherit" ? "inherit route" : node.data.model;
      return `${model} · ${node.data.history === "full" ? "full history" : node.data.history}`;
    }
    case "router":
      return node.data.mode === "intent"
        ? `Intent · ${plural(node.data.intentLabels.length, "label")}`
        : `Rules · ${plural(node.data.rules.length, "rule")}`;
    case "set_variable":
      return node.data.assignments.length === 0
        ? "No assignments"
        : `${node.data.assignments.length} assignment${node.data.assignments.length === 1 ? "" : "s"}`;
    case "webhook":
      return `${node.data.method} ${node.data.url || "(no URL)"}`;
    case "memory":
      return `${node.data.operation} ${node.data.key}`;
    case "mcp_tool":
      return node.data.toolName ? `${node.data.toolName}` : "No tool selected";
    case "client_action":
      return `${node.data.toolName} · waits for the client`;
    case "reply":
      return node.data.template.replace(/\{\{[^}]*\}\}/g, "…").slice(0, 80) || "Empty reply";
    case "end":
      return "Ends the turn";
    case "subflow_input":
      return node.data.params.length === 0
        ? "No parameters"
        : plural(node.data.params.length, "parameter");
    case "subflow_output":
      return `${node.data.label} · ${plural(node.data.values.length, "value")}`;
    case "call_subflow":
      return node.data.subflowName ?? node.data.subflowId ?? "No subflow selected";
  }
}

/** Handles that lead to another node, used by the canvas to place connection anchors. */
export function isTerminalType(type: NodeType): boolean {
  return type === "end" || type === "subflow_output";
}

/** Palette entries offered for a flow kind. */
export function nodeCatalogFor(kind: FlowKind): NodeCatalogEntry[] {
  return nodeCatalog.filter((entry) => !entry.kinds || entry.kinds.includes(kind));
}

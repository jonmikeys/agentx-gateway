"use client";

import { Plus, Trash2 } from "lucide-react";
import { useId } from "react";
import type { EditorNodeData } from "@/app/(crm)/chatflows/[id]/flow-editor-utils";
import { TemplateField } from "@/app/(crm)/chatflows/[id]/template-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type {
  LlmNodeData,
  McpToolNodeData,
  MemoryNodeData,
  ReplyNodeData,
  RouterNodeData,
  SetVariableNodeData,
  WebhookNodeData,
} from "@/lib/agents/graph";
import type { VariableSuggestion } from "@/lib/agents/templates";

export interface McpOption {
  id: string;
  name: string;
  exposed_name: string;
  server_id: string;
  server_name: string;
}

interface PropertiesPanelProps {
  data?: EditorNodeData;
  nodeType?: string;
  routes: string[];
  mcpServers: { id: string; name: string; slug: string; enabled: boolean }[];
  mcpTools: McpOption[];
  variables: VariableSuggestion[];
  knownNodeIds: string[];
  onChange: (data: EditorNodeData) => void;
}

function Field({ label, children, id }: { label: string; children: React.ReactNode; id?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  id,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  id?: string;
}) {
  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      value={Number.isFinite(value) ? value : 0}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
}

function RouteSelect({
  value,
  onChange,
  routes,
  allowInherit,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  routes: string[];
  allowInherit: boolean;
  id?: string;
}) {
  const missing = value !== "inherit" && !routes.includes(value);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="Choose a route" />
      </SelectTrigger>
      <SelectContent>
        {allowInherit && <SelectItem value="inherit">Inherit request / agent default</SelectItem>}
        {missing && value && <SelectItem value={value}>{value} (missing)</SelectItem>}
        {routes.map((route) => (
          <SelectItem key={route} value={route}>
            {route}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Right-hand inspector. Forms mirror the node Zod schemas and the registry pickers. */
export function PropertiesPanel({
  data,
  nodeType,
  routes,
  mcpServers,
  mcpTools,
  variables,
  knownNodeIds,
  onChange,
}: PropertiesPanelProps) {
  const prefix = useId();
  const fieldId = (name: string) => `${prefix}-${name}`;

  if (!data || !nodeType) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <p className="text-sm text-muted-foreground">
          Select a node to edit its settings, or add one from the palette.
        </p>
      </div>
    );
  }

  const update = (patch: Record<string, unknown>) =>
    onChange({ ...data, ...patch } as EditorNodeData);

  const common = (
    <>
      <Field label="Title" id={fieldId("title")}>
        <Input
          id={fieldId("title")}
          value={data.title}
          onChange={(event) => update({ title: event.target.value })}
        />
      </Field>
      <Field label="Comment" id={fieldId("comment")}>
        <Textarea
          id={fieldId("comment")}
          rows={2}
          placeholder="A note for editors (never executed)."
          value={data.comment ?? ""}
          onChange={(event) => update({ comment: event.target.value })}
        />
      </Field>
    </>
  );

  if (nodeType === "llm") {
    const llm = data as LlmNodeData;
    return (
      <div className="space-y-4 p-4">
        {common}
        <Field label="Model route" id={fieldId("model")}>
          <RouteSelect
            id={fieldId("model")}
            value={llm.model}
            routes={routes}
            allowInherit
            onChange={(value) => update({ model: value })}
          />
        </Field>
        <Field label="System prompt">
          <TemplateField
            value={llm.systemPrompt}
            onChange={(value) => update({ systemPrompt: value })}
            variables={variables}
            knownNodeIds={knownNodeIds}
            placeholder="You are a helpful lobby greeter."
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="History" id={fieldId("history")}>
            <Select value={llm.history} onValueChange={(value) => update({ history: value })}>
              <SelectTrigger id={fieldId("history")} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Full</SelectItem>
                <SelectItem value="last_n">Last N</SelectItem>
                <SelectItem value="none">None</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {llm.history === "last_n" && (
            <Field label="Messages" id={fieldId("historyLimit")}>
              <NumberInput
                id={fieldId("historyLimit")}
                value={llm.historyLimit}
                min={1}
                max={100}
                onChange={(value) => update({ historyLimit: value })}
              />
            </Field>
          )}
        </div>
        <Field label="Output variable" id={fieldId("output")}>
          <Input
            id={fieldId("output")}
            className="font-mono text-xs"
            value={llm.outputVariable}
            onChange={(event) => update({ outputVariable: event.target.value })}
          />
        </Field>
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={fieldId("stream")} className="text-xs">
            Stream when terminal
          </Label>
          <Switch
            id={fieldId("stream")}
            checked={llm.stream}
            onCheckedChange={(checked) => update({ stream: checked })}
          />
        </div>
        <Field label="MCP tools">
          {mcpTools.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No allowed MCP tools. Allow tools on an MCP server first.
            </p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
              {mcpTools.map((tool) => (
                <div key={tool.id} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    aria-label={`Offer ${tool.exposed_name}`}
                    checked={llm.mcpToolIds.includes(tool.id)}
                    onCheckedChange={(checked) =>
                      update({
                        mcpToolIds: checked
                          ? [...llm.mcpToolIds, tool.id]
                          : llm.mcpToolIds.filter((id) => id !== tool.id),
                      })
                    }
                  />
                  <span className="font-mono">{tool.exposed_name}</span>
                  <span className="text-muted-foreground">{tool.server_name}</span>
                </div>
              ))}
            </div>
          )}
        </Field>
      </div>
    );
  }

  if (nodeType === "router") {
    const router = data as RouterNodeData;
    return (
      <div className="space-y-4 p-4">
        {common}
        <Field label="Mode" id={fieldId("mode")}>
          <Select value={router.mode} onValueChange={(value) => update({ mode: value })}>
            <SelectTrigger id={fieldId("mode")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rules">Rules</SelectItem>
              <SelectItem value="intent">Intent (LLM picks a label)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Model route (intent)" id={fieldId("routerModel")}>
          <RouteSelect
            id={fieldId("routerModel")}
            value={router.model}
            routes={routes}
            allowInherit
            onChange={(value) => update({ model: value })}
          />
        </Field>
        {router.mode === "rules" ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Rules (first match wins)</span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-label="Add rule"
                onClick={() =>
                  update({
                    rules: [
                      ...router.rules,
                      {
                        id: `rule_${Date.now().toString(36)}`,
                        label: `Rule ${router.rules.length + 1}`,
                        operator: "contains",
                        subject: "{{input.text}}",
                        value: "",
                      },
                    ],
                  })
                }
              >
                <Plus />
                Add
              </Button>
            </div>
            {router.rules.map((rule, index) => (
              <div key={rule.id} className="space-y-2 rounded-md border p-2">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Rule ${index + 1} label`}
                    value={rule.label}
                    onChange={(event) =>
                      update({
                        rules: router.rules.map((entry, position) =>
                          position === index ? { ...entry, label: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove rule ${index + 1}`}
                    onClick={() =>
                      update({ rules: router.rules.filter((_, position) => position !== index) })
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
                <Select
                  value={rule.operator}
                  onValueChange={(value) =>
                    update({
                      rules: router.rules.map((entry, position) =>
                        position === index ? { ...entry, operator: value } : entry,
                      ),
                    })
                  }
                >
                  <SelectTrigger aria-label={`Rule ${index + 1} operator`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="equals">equals</SelectItem>
                    <SelectItem value="contains">contains</SelectItem>
                    <SelectItem value="regex">regex</SelectItem>
                  </SelectContent>
                </Select>
                <TemplateField
                  label="Subject"
                  value={rule.subject}
                  onChange={(value) =>
                    update({
                      rules: router.rules.map((entry, position) =>
                        position === index ? { ...entry, subject: value } : entry,
                      ),
                    })
                  }
                  variables={variables}
                  knownNodeIds={knownNodeIds}
                  multiline={false}
                />
                <TemplateField
                  label="Value"
                  value={rule.value}
                  onChange={(value) =>
                    update({
                      rules: router.rules.map((entry, position) =>
                        position === index ? { ...entry, value } : entry,
                      ),
                    })
                  }
                  variables={variables}
                  knownNodeIds={knownNodeIds}
                  multiline={false}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Intent labels</span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-label="Add intent label"
                onClick={() => update({ intentLabels: [...router.intentLabels, "label"] })}
              >
                <Plus />
                Add
              </Button>
            </div>
            {router.intentLabels.map((label, index) => (
              <div key={label} className="flex items-center gap-2">
                <Input
                  aria-label={`Intent label ${index + 1}`}
                  value={label}
                  onChange={(event) =>
                    update({
                      intentLabels: router.intentLabels.map((entry, position) =>
                        position === index ? event.target.value : entry,
                      ),
                    })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove intent label ${index + 1}`}
                  onClick={() =>
                    update({
                      intentLabels: router.intentLabels.filter((_, position) => position !== index),
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <TemplateField
              label="Instruction"
              value={router.intentInstruction}
              onChange={(value) => update({ intentInstruction: value })}
              variables={variables}
              knownNodeIds={knownNodeIds}
            />
          </div>
        )}
        <Field label="Default label" id={fieldId("defaultLabel")}>
          <Input
            id={fieldId("defaultLabel")}
            value={router.defaultLabel}
            onChange={(event) => update({ defaultLabel: event.target.value })}
          />
        </Field>
      </div>
    );
  }

  if (nodeType === "set_variable") {
    const setter = data as SetVariableNodeData;
    return (
      <div className="space-y-4 p-4">
        {common}
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">Assignments</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label="Add assignment"
            onClick={() =>
              update({ assignments: [...setter.assignments, { key: "var", value: "" }] })
            }
          >
            <Plus />
            Add
          </Button>
        </div>
        {setter.assignments.map((assignment, index) => (
          <div
            key={`${assignment.key}-${assignment.value}`}
            className="space-y-2 rounded-md border p-2"
          >
            <div className="flex items-center gap-2">
              <Input
                aria-label={`Assignment ${index + 1} name`}
                className="font-mono text-xs"
                value={assignment.key}
                onChange={(event) =>
                  update({
                    assignments: setter.assignments.map((entry, position) =>
                      position === index ? { ...entry, key: event.target.value } : entry,
                    ),
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove assignment ${index + 1}`}
                onClick={() =>
                  update({
                    assignments: setter.assignments.filter((_, position) => position !== index),
                  })
                }
              >
                <Trash2 />
              </Button>
            </div>
            <TemplateField
              value={assignment.value}
              onChange={(value) =>
                update({
                  assignments: setter.assignments.map((entry, position) =>
                    position === index ? { ...entry, value } : entry,
                  ),
                })
              }
              variables={variables}
              knownNodeIds={knownNodeIds}
              rows={2}
            />
          </div>
        ))}
      </div>
    );
  }

  if (nodeType === "webhook") {
    const webhook = data as WebhookNodeData;
    return (
      <div className="space-y-4 p-4">
        {common}
        <Field label="Method" id={fieldId("method")}>
          <Select value={webhook.method} onValueChange={(value) => update({ method: value })}>
            <SelectTrigger id={fieldId("method")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
                <SelectItem key={method} value={method}>
                  {method}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <TemplateField
          label="URL"
          value={webhook.url}
          onChange={(value) => update({ url: value })}
          variables={variables}
          knownNodeIds={knownNodeIds}
          multiline={false}
        />
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Headers (encrypted)</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label="Add header"
              onClick={() => update({ headers: [...webhook.headers, { name: "", value: "" }] })}
            >
              <Plus />
              Add
            </Button>
          </div>
          {webhook.headers.map((header, index) => (
            <div
              key={`${header.name}-${header.value ?? header.masked ?? ""}`}
              className="space-y-1 rounded-md border p-2"
            >
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`Header ${index + 1} name`}
                  placeholder="X-Api-Key"
                  value={header.name}
                  onChange={(event) =>
                    update({
                      headers: webhook.headers.map((entry, position) =>
                        position === index ? { ...entry, name: event.target.value } : entry,
                      ),
                    })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove header ${index + 1}`}
                  onClick={() =>
                    update({ headers: webhook.headers.filter((_, position) => position !== index) })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
              <Input
                aria-label={`Header ${index + 1} value`}
                placeholder={header.masked ? `Stored: ${header.masked}` : "Value"}
                value={header.value ?? ""}
                onChange={(event) =>
                  update({
                    headers: webhook.headers.map((entry, position) =>
                      position === index ? { ...entry, value: event.target.value } : entry,
                    ),
                  })
                }
              />
            </div>
          ))}
        </div>
        <TemplateField
          label="Body template"
          value={webhook.bodyTemplate}
          onChange={(value) => update({ bodyTemplate: value })}
          variables={variables}
          knownNodeIds={knownNodeIds}
          rows={5}
        />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Timeout (ms)" id={fieldId("timeout")}>
            <NumberInput
              id={fieldId("timeout")}
              value={webhook.timeoutMs}
              min={500}
              max={60000}
              onChange={(value) => update({ timeoutMs: value })}
            />
          </Field>
          <Field label="Retries" id={fieldId("retries")}>
            <NumberInput
              id={fieldId("retries")}
              value={webhook.retries}
              min={0}
              max={3}
              onChange={(value) => update({ retries: value })}
            />
          </Field>
        </div>
        <Field label="Response cap (bytes)" id={fieldId("cap")}>
          <NumberInput
            id={fieldId("cap")}
            value={webhook.maxResponseBytes}
            min={1024}
            max={5000000}
            onChange={(value) => update({ maxResponseBytes: value })}
          />
        </Field>
        <Field label="Output variable" id={fieldId("webhookOutput")}>
          <Input
            id={fieldId("webhookOutput")}
            className="font-mono text-xs"
            value={webhook.outputVariable}
            onChange={(event) => update({ outputVariable: event.target.value })}
          />
        </Field>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">JSON path mappings</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label="Add mapping"
              onClick={() =>
                update({ mappings: [...webhook.mappings, { variable: "value", path: "" }] })
              }
            >
              <Plus />
              Add
            </Button>
          </div>
          {webhook.mappings.map((mapping, index) => (
            <div key={`${mapping.variable}-${mapping.path}`} className="flex items-center gap-2">
              <Input
                aria-label={`Mapping ${index + 1} variable`}
                className="font-mono text-xs"
                value={mapping.variable}
                onChange={(event) =>
                  update({
                    mappings: webhook.mappings.map((entry, position) =>
                      position === index ? { ...entry, variable: event.target.value } : entry,
                    ),
                  })
                }
              />
              <Input
                aria-label={`Mapping ${index + 1} JSON path`}
                className="font-mono text-xs"
                placeholder="data.value"
                value={mapping.path}
                onChange={(event) =>
                  update({
                    mappings: webhook.mappings.map((entry, position) =>
                      position === index ? { ...entry, path: event.target.value } : entry,
                    ),
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove mapping ${index + 1}`}
                onClick={() =>
                  update({ mappings: webhook.mappings.filter((_, position) => position !== index) })
                }
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (nodeType === "memory") {
    const memory = data as MemoryNodeData;
    return (
      <div className="space-y-4 p-4">
        {common}
        <Field label="Operation" id={fieldId("operation")}>
          <Select value={memory.operation} onValueChange={(value) => update({ operation: value })}>
            <SelectTrigger id={fieldId("operation")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="get">get</SelectItem>
              <SelectItem value="set">set</SelectItem>
              <SelectItem value="append">append</SelectItem>
              <SelectItem value="delete">delete</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <TemplateField
          label="Key"
          value={memory.key}
          onChange={(value) => update({ key: value })}
          variables={variables}
          knownNodeIds={knownNodeIds}
          multiline={false}
        />
        {memory.operation !== "get" && memory.operation !== "delete" && (
          <TemplateField
            label="Value"
            value={memory.value}
            onChange={(value) => update({ value })}
            variables={variables}
            knownNodeIds={knownNodeIds}
          />
        )}
        <Field label="Output variable" id={fieldId("memoryOutput")}>
          <Input
            id={fieldId("memoryOutput")}
            className="font-mono text-xs"
            value={memory.outputVariable}
            onChange={(event) => update({ outputVariable: event.target.value })}
          />
        </Field>
      </div>
    );
  }

  if (nodeType === "mcp_tool") {
    const mcp = data as McpToolNodeData;
    const toolsForServer = mcpTools.filter((tool) => tool.server_id === mcp.serverId);
    return (
      <div className="space-y-4 p-4">
        {common}
        <Field label="MCP server" id={fieldId("mcpServer")}>
          <Select
            value={mcp.serverId}
            onValueChange={(value) => update({ serverId: value, toolName: "" })}
          >
            <SelectTrigger id={fieldId("mcpServer")} className="w-full">
              <SelectValue placeholder="Choose a server" />
            </SelectTrigger>
            <SelectContent>
              {mcpServers.map((server) => (
                <SelectItem key={server.id} value={server.id}>
                  {server.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Allowed tool" id={fieldId("mcpTool")}>
          <Select
            value={mcp.toolName}
            onValueChange={(value) => update({ toolName: value })}
            disabled={!mcp.serverId}
          >
            <SelectTrigger id={fieldId("mcpTool")} className="w-full">
              <SelectValue placeholder="Choose a tool" />
            </SelectTrigger>
            <SelectContent>
              {toolsForServer.map((tool) => (
                <SelectItem key={tool.id} value={tool.exposed_name.split("__").slice(1).join("__")}>
                  {tool.exposed_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Arguments</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label="Add argument"
              onClick={() => update({ args: [...mcp.args, { name: "", value: "" }] })}
            >
              <Plus />
              Add
            </Button>
          </div>
          {mcp.args.map((argument, index) => (
            <div
              key={`${argument.name}-${argument.value}`}
              className="space-y-1 rounded-md border p-2"
            >
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`Argument ${index + 1} name`}
                  placeholder="text"
                  value={argument.name}
                  onChange={(event) =>
                    update({
                      args: mcp.args.map((entry, position) =>
                        position === index ? { ...entry, name: event.target.value } : entry,
                      ),
                    })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove argument ${index + 1}`}
                  onClick={() =>
                    update({ args: mcp.args.filter((_, position) => position !== index) })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
              <TemplateField
                value={argument.value}
                onChange={(value) =>
                  update({
                    args: mcp.args.map((entry, position) =>
                      position === index ? { ...entry, value } : entry,
                    ),
                  })
                }
                variables={variables}
                knownNodeIds={knownNodeIds}
                rows={2}
              />
            </div>
          ))}
        </div>
        <Field label="Output variable" id={fieldId("mcpOutput")}>
          <Input
            id={fieldId("mcpOutput")}
            className="font-mono text-xs"
            value={mcp.outputVariable}
            onChange={(event) => update({ outputVariable: event.target.value })}
          />
        </Field>
      </div>
    );
  }

  if (nodeType === "reply") {
    const reply = data as ReplyNodeData;
    return (
      <div className="space-y-4 p-4">
        {common}
        <TemplateField
          label="Reply template"
          value={reply.template}
          onChange={(value) => update({ template: value })}
          variables={variables}
          knownNodeIds={knownNodeIds}
        />
      </div>
    );
  }

  return <div className="space-y-4 p-4">{common}</div>;
}

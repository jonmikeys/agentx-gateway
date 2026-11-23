/**
 * Safe `{{...}}` template interpolation (docs/agents.md). No evaluation: only dotted property
 * lookups into a plain scope object. Missing paths render as an empty string and can be flagged
 * by the editor as invalid references.
 */

export const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export interface TemplateScope {
  input: { text: string; sessionId?: string; [key: string]: unknown };
  vars: Record<string, unknown>;
  memory: Record<string, unknown>;
  nodes: Record<string, { output: unknown }>;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "function" || typeof value === "symbol") return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Resolves a dotted path (`a.b.0.c`) against an object; undefined when any segment is missing. */
export function resolvePath(scope: unknown, path: string): unknown {
  let current: unknown = scope;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Every `{{...}}` reference in a template, in order, without duplicates. */
export function templateReferences(template: string): string[] {
  const references = new Set<string>();
  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    const path = match[1]?.trim();
    if (path) references.add(path);
  }
  return [...references];
}

/** Replaces every reference with its rendered value; unknown references become an empty string. */
export function renderTemplate(template: string, scope: TemplateScope): string {
  return template.replace(TEMPLATE_PATTERN, (_full, rawPath: string) => {
    const value = resolvePath(scope, rawPath.trim());
    return renderValue(value);
  });
}

/**
 * True when a reference looks resolvable. `nodes.<id>` is valid for any existing node id;
 * `vars`/`memory` accept any key (they are created at run time), `input` only its known fields.
 */
export function isValidReference(path: string, knownNodeIds: Iterable<string>): boolean {
  const segments = path.split(".");
  if (segments.length < 2) return false;
  const [root, ...rest] = segments;
  if (!root || rest.length === 0) return false;
  if (root === "nodes") {
    const [nodeId, field] = rest;
    if (!nodeId || !knownNodeIdsHas(knownNodeIds, nodeId)) return false;
    return field === "output" || (field !== undefined && rest.length > 1);
  }
  if (root === "input") {
    return ["text", "sessionId", "messages", "model", "agentId"].includes(rest[0] ?? "");
  }
  if (root === "vars" || root === "memory") return true;
  return false;
}

function knownNodeIdsHas(ids: Iterable<string>, id: string): boolean {
  if (Array.isArray(ids)) return ids.includes(id);
  for (const candidate of ids) if (candidate === id) return true;
  return false;
}

/** References in a template that the editor should underline as invalid. */
export function invalidReferences(template: string, knownNodeIds: Iterable<string>): string[] {
  return templateReferences(template).filter(
    (reference) => !isValidReference(reference, knownNodeIds),
  );
}

export interface VariableSuggestion {
  /** Full path inserted after `{{`. */
  path: string;
  label: string;
  detail: string;
}

/** Autocomplete entries for the editor: input fields, variables, memory and every node output. */
export function variableSuggestions(
  knownNodeIds: { id: string; title: string }[],
  knownVars: string[] = [],
): VariableSuggestion[] {
  const suggestions: VariableSuggestion[] = [
    { path: "input.text", label: "input.text", detail: "Latest user message" },
    { path: "input.sessionId", label: "input.sessionId", detail: "Session id" },
    { path: "input.messages", label: "input.messages", detail: "Conversation history" },
  ];
  for (const name of [...new Set(knownVars)].filter(Boolean)) {
    suggestions.push({ path: `vars.${name}`, label: `vars.${name}`, detail: "Flow variable" });
  }
  suggestions.push({ path: "memory.key", label: "memory.key", detail: "Session memory value" });
  for (const node of knownNodeIds) {
    suggestions.push({
      path: `nodes.${node.id}.output`,
      label: `nodes.${node.id}.output`,
      detail: `Output of ${node.title}`,
    });
  }
  return suggestions;
}

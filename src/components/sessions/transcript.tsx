"use client";

import {
  Brain,
  ChevronDown,
  CircleAlert,
  Clock,
  ScrollText,
  Timer,
  User,
  Wrench,
} from "lucide-react";
import { MarkdownContent } from "@/components/sessions/markdown-content";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatCount, formatDuration } from "@/lib/format";
import type {
  LinkedRequestView,
  SessionDetail,
  TranscriptItemView,
  TurnView,
} from "@/lib/session-types";

function prettyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

/** Pretty-prints a tool result when it is JSON; otherwise returns it unchanged. */
function formatToolResult(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function UserBubble({ item }: { item: TranscriptItemView }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-primary-foreground">
        <div className="mb-1 flex items-center gap-1 text-xs opacity-80">
          <User className="size-3" />
          User
        </div>
        <p className="text-sm break-words whitespace-pre-wrap">{item.content}</p>
      </div>
    </div>
  );
}

function AssistantBubble({ item }: { item: TranscriptItemView }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm border bg-card px-4 py-2 text-card-foreground">
        <div className="mb-1 text-xs text-muted-foreground">Assistant</div>
        <MarkdownContent text={item.content} />
      </div>
    </div>
  );
}

function ThinkingBlock({ item }: { item: TranscriptItemView }) {
  return (
    <Collapsible className="max-w-[85%] rounded-lg border border-dashed bg-muted/40">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground"
        >
          <Brain className="size-4" />
          <span className="font-medium">Thinking</span>
          <span className="text-xs">{formatCount(item.content.length)} characters</span>
          <ChevronDown className="ml-auto size-4 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="border-t px-3 py-2 text-sm break-words whitespace-pre-wrap text-muted-foreground">
          {item.content}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolCallCard({
  call,
  result,
}: {
  call: TranscriptItemView;
  result: TranscriptItemView | undefined;
}) {
  const duration = result
    ? new Date(result.created_at).getTime() - new Date(call.created_at).getTime()
    : undefined;
  return (
    <div className="max-w-[85%] overflow-hidden rounded-lg border bg-card text-card-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Wrench className="size-4 text-muted-foreground" />
        <span className="font-mono text-sm font-medium">{call.tool_name ?? "unknown tool"}</span>
        <Badge variant="outline">{call.tool_source === "mcp" ? "MCP" : "Unity"}</Badge>
        {duration !== undefined && duration >= 0 && (
          <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            <Timer className="size-3" />
            {formatDuration(duration)}
          </span>
        )}
      </div>
      <div className="space-y-3 px-3 py-2">
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Arguments</div>
          <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
            {prettyJson(call.tool_args)}
          </pre>
        </div>
        <div className="rounded-md border border-dashed p-2">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Result</div>
          {result ? (
            <pre className="overflow-x-auto font-mono text-xs break-words whitespace-pre-wrap">
              {formatToolResult(result.content)}
            </pre>
          ) : (
            <span className="text-xs text-muted-foreground">No result recorded yet.</span>
          )}
        </div>
      </div>
    </div>
  );
}

function ErrorAlert({ item }: { item: TranscriptItemView }) {
  return (
    <div
      role="alert"
      className="flex max-w-[85%] items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="break-words">{item.content}</span>
    </div>
  );
}

function AttemptsPopover({ request }: { request: LinkedRequestView }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs">
          {request.attempts.length} attempts
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80" aria-label="Failover attempts">
        <div className="mb-2 text-sm font-medium">Failover attempts</div>
        <ol className="space-y-2 text-xs">
          {request.attempts.map((attempt) => (
            <li
              key={`${attempt.provider_id}-${attempt.model}-${attempt.outcome}-${attempt.error_code ?? ""}`}
              className="flex items-start justify-between gap-2"
            >
              <span>
                <span className="font-medium">{attempt.provider_name}</span>
                <span className="block text-muted-foreground">{attempt.model}</span>
              </span>
              <span className="text-right">
                <Badge variant={attempt.outcome === "ok" ? "secondary" : "destructive"}>
                  {attempt.outcome}
                </Badge>
                <span className="mt-1 block text-muted-foreground">
                  {attempt.error_code ? `${attempt.error_code} · ` : ""}
                  {formatDuration(attempt.latency_ms)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  );
}

function RequestMetadata({ request }: { request: LinkedRequestView }) {
  return (
    <div
      data-testid="turn-metadata"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
    >
      <Badge variant={request.status === "ok" ? "secondary" : "destructive"}>
        {request.provider_name ?? "no provider"}
      </Badge>
      {request.upstream_model && <span className="font-mono">{request.upstream_model}</span>}
      <span className="flex items-center gap-1">
        <Clock className="size-3" />
        {formatDuration(request.duration_ms)}
      </span>
      <span>TTFT {formatDuration(request.ttft_ms)}</span>
      {request.usage && <span>{formatCount(request.usage.total_tokens)} tokens</span>}
      {request.attempts.length > 1 && <AttemptsPopover request={request} />}
      {request.status === "error" && <span>error: {request.error_code ?? "unknown"}</span>}
    </div>
  );
}

function renderItems(
  items: TranscriptItemView[],
  resultsByCall: Map<string, TranscriptItemView>,
  linkedResultIds: Set<string>,
) {
  return items.map((item) => {
    switch (item.kind) {
      case "user_message":
        return <UserBubble key={item.id} item={item} />;
      case "assistant_message":
        return <AssistantBubble key={item.id} item={item} />;
      case "reasoning":
        return <ThinkingBlock key={item.id} item={item} />;
      case "tool_call":
        return (
          <ToolCallCard
            key={item.id}
            call={item}
            result={item.tool_call_id ? resultsByCall.get(item.tool_call_id) : undefined}
          />
        );
      case "tool_result":
        // Results with a matching call are nested inside the call's card.
        return linkedResultIds.has(item.id) ? null : (
          <ToolCallCard
            key={item.id}
            call={{ ...item, kind: "tool_call", tool_args: null }}
            result={item}
          />
        );
      case "error":
        return <ErrorAlert key={item.id} item={item} />;
      default:
        return null;
    }
  });
}

/** Collapsible system prompt(s) at the top of the transcript. */
export function SystemPromptBlock({ prompts }: { prompts: TranscriptItemView[] }) {
  if (prompts.length === 0) return null;
  return (
    <Collapsible className="rounded-lg border bg-muted/40">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        >
          <ScrollText className="size-4 text-muted-foreground" />
          <span className="font-medium">System prompt</span>
          {prompts.length > 1 && (
            <span className="text-xs text-muted-foreground">{prompts.length} versions</span>
          )}
          <ChevronDown className="ml-auto size-4 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 border-t px-3 py-2">
        {prompts.map((prompt, index) => (
          <div key={prompt.id}>
            {prompts.length > 1 && (
              <div className="mb-1 text-xs text-muted-foreground">
                {index === 0 ? "Initial" : `Changed (version ${index + 1})`}
              </div>
            )}
            <p className="text-sm break-words whitespace-pre-wrap">{prompt.content}</p>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function TurnSection({
  turn,
  resultsByCall,
  linkedResultIds,
}: {
  turn: TurnView;
  resultsByCall: Map<string, TranscriptItemView>;
  linkedResultIds: Set<string>;
}) {
  const visible = turn.items.filter((item) => item.kind !== "system_prompt");
  return (
    <section aria-label={`Turn ${turn.seq}`} className="space-y-3">
      <div className="flex items-center gap-3 text-xs font-medium text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        Turn {turn.seq}
        <span className="h-px flex-1 bg-border" />
      </div>
      {renderItems(visible, resultsByCall, linkedResultIds)}
      {turn.requests.length > 0 && (
        <div className="space-y-1 border-t pt-2">
          {turn.requests.map((request) => (
            <RequestMetadata key={request.id} request={request} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Chat-style timeline grouped by turn. */
export function Transcript({ session }: { session: SessionDetail }) {
  const allItems = session.turns.flatMap((turn) => turn.items);
  const callIds = new Set(
    allItems
      .filter((item) => item.kind === "tool_call" && item.tool_call_id)
      .map((i) => i.tool_call_id),
  );
  const results = allItems.filter((item) => item.kind === "tool_result" && item.tool_call_id);
  const resultsByCall = new Map(results.map((item) => [item.tool_call_id as string, item]));
  const linkedResultIds = new Set(
    results.filter((item) => callIds.has(item.tool_call_id)).map((item) => item.id),
  );
  const prompts = allItems.filter((item) => item.kind === "system_prompt");

  return (
    <div className="space-y-6">
      <SystemPromptBlock prompts={prompts} />
      {session.turns.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No transcript captured for this session yet.
        </p>
      ) : (
        session.turns.map((turn) => (
          <TurnSection
            key={turn.id}
            turn={turn}
            resultsByCall={resultsByCall}
            linkedResultIds={linkedResultIds}
          />
        ))
      )}
    </div>
  );
}

"use client";

import { ChevronDown, CircleAlert, Play, Route, Timer } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RunTrace, RunTraceStep } from "@/lib/agents/types";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SseParser } from "@/server/gateway/sse";

interface TestDrawerProps {
  flowId: string;
  nodes: { id: string; title: string; type: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRunningNode: (nodeId: string | undefined) => void;
  onTraceNode: (nodeId: string | undefined) => void;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/** Bottom drawer: test chat that streams the draft, plus the per-node trace of the last run. */
export function TestDrawer({
  flowId,
  nodes,
  open,
  onOpenChange,
  onRunningNode,
  onTraceNode,
}: TestDrawerProps) {
  const [tab, setTab] = useState<"chat" | "trace">("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("Hello!");
  const [running, setRunning] = useState(false);
  const [trace, setTrace] = useState<RunTrace | undefined>();
  const [liveSteps, setLiveSteps] = useState<RunTraceStep[]>([]);
  const [error, setError] = useState<string | undefined>();
  const titles = useRef(new Map(nodes.map((node) => [node.id, node])));
  const scrollRef = useRef<HTMLDivElement | null>(null);

  function appendToReply(delta: string) {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role === "assistant")
        next[next.length - 1] = { ...last, content: last.content + delta };
      return next;
    });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    });
  }

  async function run() {
    if (running || !input.trim()) return;
    const question = input.trim();
    setInput("");
    setError(undefined);
    setTrace(undefined);
    setLiveSteps([]);
    onTraceNode(undefined);
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", content: question },
      { id: crypto.randomUUID(), role: "assistant", content: "" },
    ]);
    setRunning(true);
    try {
      const response = await fetch(`/api/admin/flows/${flowId}/test-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: question, stream: true }),
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => undefined)) as
          | { error?: { message?: string } }
          | undefined;
        throw new Error(body?.error?.message ?? `Test run failed (HTTP ${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        const events = done ? parser.flush() : parser.push(decoder.decode(value, { stream: true }));
        for (const event of events) {
          if (!event.data) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(event.data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (payload.type === "node_start") {
            const id = String(payload.node_id ?? "");
            onRunningNode(id);
            continue;
          }
          if (payload.type === "node_end") {
            const id = String(payload.node_id ?? "");
            const known = titles.current.get(id);
            onRunningNode(undefined);
            setLiveSteps((current) => [
              ...current,
              {
                node_id: id,
                node_type: known?.type ?? String(payload.node_type ?? ""),
                title: known?.title ?? id,
                status: (payload.status as "ok" | "error") ?? "ok",
                started_at: new Date().toISOString(),
                duration_ms: Number(payload.duration_ms ?? 0),
                error: payload.error ? String(payload.error) : undefined,
              },
            ]);
            continue;
          }
          if (payload.type === "text") {
            appendToReply(String(payload.delta ?? ""));
            continue;
          }
          if (payload.type === "done") {
            setTrace(payload.trace as RunTrace);
            setLiveSteps(((payload.trace as RunTrace)?.steps ?? []) as RunTraceStep[]);
            continue;
          }
          if (payload.type === "error") {
            setError(String(payload.message ?? "Test run failed"));
          }
        }
        if (done) break;
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Test run failed";
      setError(message);
      toast.error(message);
    } finally {
      setRunning(false);
      onRunningNode(undefined);
    }
  }

  const steps = trace?.steps ?? liveSteps;

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={open}
          aria-label={open ? "Close test drawer" : "Open test drawer"}
          onClick={() => onOpenChange(!open)}
        >
          <ChevronDown className={cn("transition-transform", !open && "-rotate-90")} />
          Test
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={tab === "chat"}
          onClick={() => {
            setTab("chat");
            onOpenChange(true);
          }}
        >
          Chat
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={tab === "trace"}
          onClick={() => {
            setTab("trace");
            onOpenChange(true);
          }}
        >
          <Route />
          Trace
        </Button>
        {trace && (
          <Badge variant={trace.status === "ok" ? "secondary" : "destructive"} className="ml-auto">
            {trace.status} ﾂｷ {trace.steps.length} steps ﾂｷ {formatDuration(trace.duration_ms)}
          </Badge>
        )}
      </div>

      {open && (
        <div className="grid gap-3 p-3 md:grid-cols-2">
          <div className="flex min-h-56 min-w-0 flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                aria-pressed={tab === "chat"}
                onClick={() => setTab("chat")}
              >
                Test chat
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-pressed={tab === "trace"}
                onClick={() => setTab("trace")}
              >
                Trace
              </Button>
            </div>
            {tab === "chat" ? (
              <>
                <div
                  ref={scrollRef}
                  data-testid="test-chat"
                  className="h-44 space-y-2 overflow-y-auto rounded-md border bg-background p-2 text-sm"
                >
                  {messages.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Send a message to run the saved draft. Nothing is published and session memory
                      is isolated.
                    </p>
                  ) : (
                    messages.map((message) => (
                      <div
                        key={message.id}
                        className={cn(
                          "max-w-[90%] rounded-md px-2 py-1.5",
                          message.role === "user"
                            ? "ml-auto bg-primary text-primary-foreground"
                            : "bg-muted",
                        )}
                      >
                        <p className="text-xs font-medium opacity-70">
                          {message.role === "user" ? "You" : "Agent"}
                        </p>
                        <p className="break-words whitespace-pre-wrap">
                          {message.content || (running ? "…" : "")}
                        </p>
                      </div>
                    ))
                  )}
                </div>
                {error && (
                  <p role="alert" className="flex items-center gap-1 text-xs text-destructive">
                    <CircleAlert className="size-3.5" />
                    {error}
                  </p>
                )}
                <div className="flex items-end gap-2">
                  <Textarea
                    aria-label="Test message"
                    rows={2}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void run();
                      }
                    }}
                  />
                  <Button onClick={run} disabled={running} aria-label="Run test message">
                    <Play />
                    {running ? "Running…" : "Run"}
                  </Button>
                </div>
              </>
            ) : (
              <div data-testid="test-trace" className="h-64 overflow-y-auto rounded-md border">
                {steps.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">
                    Run a test message to see each node's input, output and timing.
                  </p>
                ) : (
                  <ol>
                    {steps.map((step) => (
                      <li key={`${step.node_id}-${step.started_at}-${step.title}`}>
                        <button
                          type="button"
                          className="flex w-full flex-wrap items-center gap-2 border-b px-2 py-1.5 text-left text-xs hover:bg-accent"
                          onClick={() => {
                            onTraceNode(step.node_id);
                            setTab("trace");
                          }}
                          aria-label={`Highlight ${step.title} step`}
                        >
                          <span
                            className={cn(
                              "size-2 rounded-full",
                              step.status === "ok" ? "bg-primary" : "bg-destructive",
                            )}
                          />
                          <span className="font-medium">{step.title}</span>
                          <span className="font-mono text-muted-foreground">{step.node_type}</span>
                          <span className="ml-auto flex items-center gap-1 text-muted-foreground">
                            <Timer className="size-3" />
                            {formatDuration(step.duration_ms)}
                          </span>
                          {step.error && (
                            <span className="w-full break-words text-destructive">
                              {step.error}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </div>
          <div className="min-w-0 rounded-md border p-2">
            <p className="mb-2 text-xs font-medium">Available variables</p>
            <p className="text-xs text-muted-foreground">
              Use <code className="font-mono">{"{{input.text}}"}</code>,{" "}
              <code className="font-mono">{"{{vars.x}}"}</code>,{" "}
              <code className="font-mono">{"{{memory.x}}"}</code> or{" "}
              <code className="font-mono">{"{{nodes.<id>.output}}"}</code> in templates.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Test runs use an isolated memory store, so they never change a real session.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

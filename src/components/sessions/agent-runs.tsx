"use client";

import { ChevronDown, CircleAlert, CircleCheck, CircleDashed, Route } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatTimestamp } from "@/lib/admin-client";
import type { RunLogView, RunTraceStep, SessionMemoryView } from "@/lib/agents/types";
import { formatDuration } from "@/lib/format";

function StepRow({ step }: { step: RunTraceStep }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-3 py-2 text-xs first:border-t-0">
      {step.status === "ok" ? (
        <CircleCheck className="size-3.5 text-muted-foreground" />
      ) : step.status === "skipped" ? (
        <CircleDashed className="size-3.5 text-muted-foreground" />
      ) : (
        <CircleAlert className="size-3.5 text-destructive" />
      )}
      <span className="font-medium">{step.title}</span>
      <Badge variant="outline" className="font-mono">
        {step.node_type}
      </Badge>
      <span className="text-muted-foreground">{formatDuration(step.duration_ms)}</span>
      {step.error && <span className="w-full break-words text-destructive">{step.error}</span>}
    </li>
  );
}

function RunCard({ run }: { run: RunLogView }) {
  return (
    <Collapsible className="rounded-lg border">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm"
        >
          <Route className="size-4 text-muted-foreground" />
          <span className="font-medium">{run.flow_name ?? run.flow_id ?? "Deleted agent"}</span>
          {run.version !== null && (
            <span className="text-xs text-muted-foreground">v{run.version}</span>
          )}
          <Badge variant={run.status === "ok" ? "secondary" : "destructive"}>{run.status}</Badge>
          <span className="text-xs text-muted-foreground">{formatDuration(run.duration_ms)}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {formatTimestamp(run.started_at)}
          </span>
          <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {(run.trace?.steps.length ?? 0) === 0 ? (
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">No steps recorded.</p>
        ) : (
          <ol className="border-t">
            {run.trace?.steps.map((step) => (
              <StepRow key={`${step.node_id}-${step.started_at}`} step={step} />
            ))}
          </ol>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Agent run traces of a session (replaces the G7a placeholder cards in the transcript viewer). */
export function AgentRunList({ runs }: { runs: RunLogView[] }) {
  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This session has no agent runs. Sessions with a direct model show only the transcript.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <RunCard key={run.id} run={run} />
      ))}
    </div>
  );
}

/** Session memory and variables written by Memory nodes. */
export function SessionMemoryPanel({ memory }: { memory: SessionMemoryView[] }) {
  if (memory.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No session memory. Memory nodes write here and keep values across turns.
      </p>
    );
  }
  return (
    <dl className="divide-y rounded-lg border">
      {memory.map((entry) => (
        <div key={entry.key} className="flex flex-col gap-1 px-3 py-2">
          <dt className="font-mono text-xs font-medium">{entry.key}</dt>
          <dd className="break-words font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value, null, 2)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

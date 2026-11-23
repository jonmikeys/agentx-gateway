"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { adminFetch, errorMessage, formatTimestamp } from "@/lib/admin-client";
import type { FlowDetail, FlowVersionDetail, FlowVersionSummary } from "@/lib/agents/types";

interface VersionDialogProps {
  open: boolean;
  flowId: string;
  onOpenChange: (open: boolean) => void;
  onRestored: (flow: FlowDetail) => void;
}

/** Published version history: view a version's graph summary and restore it into the draft. */
export function VersionDialog({ open, flowId, onOpenChange, onRestored }: VersionDialogProps) {
  const [versions, setVersions] = useState<FlowVersionSummary[]>([]);
  const [selected, setSelected] = useState<FlowVersionDetail | undefined>();
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<number | undefined>();

  useEffect(() => {
    if (!open) return;
    setSelected(undefined);
    setLoading(true);
    adminFetch<{ data: FlowVersionSummary[] }>(`flows/${flowId}/versions`)
      .then((result) => setVersions(result.data))
      .catch((error: unknown) => toast.error(errorMessage(error)))
      .finally(() => setLoading(false));
  }, [open, flowId]);

  async function view(version: number) {
    try {
      setSelected(await adminFetch<FlowVersionDetail>(`flows/${flowId}/versions/${version}`));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function restore(version: number) {
    setRestoring(version);
    try {
      const flow = await adminFetch<FlowDetail>(`flows/${flowId}/versions/${version}/restore`, {
        method: "POST",
      });
      toast.success(`Restored version ${version} into the draft`);
      onRestored(flow);
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRestoring(undefined);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Restoring copies a published version into the draft; publish again to make it live.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading versions…</p>
        ) : versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No published versions yet. Publish the chatflow to create the first one.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <ul className="space-y-2" aria-label="Published versions">
              {versions.map((version) => (
                <li key={version.version} className="rounded-md border p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">v{version.version}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatTimestamp(version.published_at)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {version.node_count} node{version.node_count === 1 ? "" : "s"}
                    </span>
                  </div>
                  {version.note && (
                    <p className="mt-1 text-xs break-words text-muted-foreground">{version.note}</p>
                  )}
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="outline"
                      size="xs"
                      aria-label={`View version ${version.version}`}
                      onClick={() => view(version.version)}
                    >
                      View
                    </Button>
                    <Button
                      variant="outline"
                      size="xs"
                      aria-label={`Restore version ${version.version}`}
                      disabled={restoring !== undefined}
                      onClick={() => restore(version.version)}
                    >
                      {restoring === version.version ? "Restoring…" : "Restore"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="min-w-0 rounded-md border p-2">
              {selected ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Version {selected.version}</p>
                  <ol className="space-y-1 text-xs">
                    {selected.graph.nodes.map((node) => (
                      <li key={node.id} className="flex justify-between gap-2">
                        <span className="truncate">{node.data.title}</span>
                        <span className="font-mono text-muted-foreground">{node.type}</span>
                      </li>
                    ))}
                  </ol>
                  <p className="text-xs text-muted-foreground">
                    {selected.graph.edges.length} connection
                    {selected.graph.edges.length === 1 ? "" : "s"}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Choose View to inspect a version's nodes before restoring it.
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

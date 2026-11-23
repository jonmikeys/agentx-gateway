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
import { type DiffEntry, diffGraphs, type GraphDiff } from "@/lib/agents/diff";
import type { FlowGraph } from "@/lib/agents/graph";
import { buildExportPayload, downloadJson } from "@/lib/agents/io";
import type { FlowDetail, FlowVersionDetail, FlowVersionSummary } from "@/lib/agents/types";

interface VersionDialogProps {
  open: boolean;
  flow: FlowDetail;
  draft: FlowGraph;
  onOpenChange: (open: boolean) => void;
  onRestored: (flow: FlowDetail) => void;
  /** Highlights the version-vs-draft diff on the canvas; undefined clears it. */
  onHighlight: (diff: GraphDiff | undefined) => void;
}

function DiffList({ title, entries }: { title: string; entries: DiffEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium">{title}</p>
      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {entries.map((entry) => (
          <li key={entry.id} className="truncate" title={`${entry.title} (${entry.kind})`}>
            {entry.title} <span className="font-mono">· {entry.kind}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Published version history: view a version, diff it against the draft, export or restore it. */
export function VersionDialog({
  open,
  flow,
  draft,
  onOpenChange,
  onRestored,
  onHighlight,
}: VersionDialogProps) {
  const [versions, setVersions] = useState<FlowVersionSummary[]>([]);
  const [selected, setSelected] = useState<FlowVersionDetail | undefined>();
  const [diff, setDiff] = useState<GraphDiff | undefined>();
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<number | undefined>();

  useEffect(() => {
    if (!open) return;
    setSelected(undefined);
    setDiff(undefined);
    onHighlight(undefined);
    setLoading(true);
    adminFetch<{ data: FlowVersionSummary[] }>(`flows/${flow.id}/versions`)
      .then((result) => setVersions(result.data))
      .catch((error: unknown) => toast.error(errorMessage(error)))
      .finally(() => setLoading(false));
  }, [open, flow.id, onHighlight]);

  function close(next: boolean) {
    // Keep the canvas highlight after closing so the diff can be inspected; the editor legend has
    // its own "Clear highlight" action.
    onOpenChange(next);
  }

  async function view(version: number) {
    try {
      setDiff(undefined);
      onHighlight(undefined);
      setSelected(await adminFetch<FlowVersionDetail>(`flows/${flow.id}/versions/${version}`));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function restore(version: number) {
    setRestoring(version);
    try {
      const restored = await adminFetch<FlowDetail>(
        `flows/${flow.id}/versions/${version}/restore`,
        {
          method: "POST",
        },
      );
      toast.success(`Restored version ${version} into the draft`);
      onRestored(restored);
      close(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRestoring(undefined);
    }
  }

  function compare(version: FlowVersionDetail) {
    const result = diffGraphs(version.graph, draft);
    setDiff(result);
    onHighlight(result);
  }

  function exportVersion(version: FlowVersionDetail) {
    const payload = buildExportPayload(
      {
        name: flow.name,
        slug: flow.slug,
        kind: flow.kind,
        description: flow.description,
        settings: flow.settings,
        version: version.version,
      },
      version.graph,
    );
    downloadJson(`${flow.slug || "chatflow"}-v${version.version}.json`, payload);
    toast.success(`Version ${version.version} exported as JSON`);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
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
                  <div className="mt-2 flex flex-wrap gap-2">
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
                    <Button
                      variant="outline"
                      size="xs"
                      aria-label={`Export version ${version.version} as JSON`}
                      onClick={() => {
                        adminFetch<FlowVersionDetail>(
                          `flows/${flow.id}/versions/${version.version}`,
                        )
                          .then(exportVersion)
                          .catch((error: unknown) => toast.error(errorMessage(error)));
                      }}
                    >
                      Export
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="min-w-0 rounded-md border p-2">
              {selected ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">Version {selected.version}</p>
                    <Button
                      variant="outline"
                      size="xs"
                      title={`Compare version ${selected.version} with the draft`}
                      onClick={() => compare(selected)}
                    >
                      Compare with draft
                    </Button>
                  </div>
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

                  {diff && (
                    <div data-testid="version-diff" className="space-y-2 border-t pt-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium">Compared with draft</span>
                        <span className="flex items-center gap-1">
                          <span className="size-2 rounded-full bg-chart-5" /> Added
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="size-2 rounded-full bg-chart-2" /> Changed
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="size-2 rounded-full bg-destructive" /> Removed
                        </span>
                      </div>
                      {diff.empty ? (
                        <p className="text-xs text-muted-foreground">
                          The draft matches this version.
                        </p>
                      ) : (
                        <>
                          <DiffList title="Added nodes" entries={diff.addedNodes} />
                          <DiffList title="Removed nodes" entries={diff.removedNodes} />
                          <DiffList title="Changed nodes" entries={diff.changedNodes} />
                          <DiffList title="Added edges" entries={diff.addedEdges} />
                          <DiffList title="Removed edges" entries={diff.removedEdges} />
                          <DiffList title="Changed edges" entries={diff.changedEdges} />
                          <p className="text-xs text-muted-foreground">
                            View only: nothing is changed until you publish or restore.
                          </p>
                        </>
                      )}
                    </div>
                  )}
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
          <Button variant="outline" onClick={() => close(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

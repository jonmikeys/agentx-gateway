"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Bot, Copy, FileJson, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { DataTable } from "@/components/crm/data-table";
import { PageHeader } from "@/components/crm/page-header";
import { TruncatedText } from "@/components/crm/truncated-text";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { adminFetch, errorMessage } from "@/lib/admin-client";
import { parseImportedFlow } from "@/lib/agents/io";
import type { FlowDetail, FlowSummary } from "@/lib/agents/types";
import type { ValidationProblem } from "@/lib/agents/validate";

export function ChatflowsView({ flows }: { flows: FlowSummary[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<FlowSummary | undefined>();
  const [busyId, setBusyId] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importProblems, setImportProblems] = useState<ValidationProblem[]>([]);
  const [imported, setImported] = useState<FlowDetail | undefined>();
  const [missingSecrets, setMissingSecrets] = useState<string[]>([]);

  function openImport() {
    setImportText("");
    setImportErrors([]);
    setImportProblems([]);
    setImported(undefined);
    setMissingSecrets([]);
    setImporting(true);
  }

  async function importFlow() {
    setImportErrors([]);
    setImportProblems([]);
    const parsed = parseImportedFlow(importText);
    if (!parsed.ok) {
      setImportErrors(parsed.errors);
      setImportProblems(parsed.problems);
      return;
    }
    setSaving(true);
    try {
      const created = await adminFetch<FlowDetail>("flows", {
        method: "POST",
        body: {
          name: parsed.flow.name,
          description: parsed.flow.description,
          kind: parsed.flow.kind,
          settings: parsed.flow.settings,
          ...(parsed.flow.slug ? { slug: parsed.flow.slug } : {}),
        },
      });
      await adminFetch(`flows/${created.id}/draft`, {
        method: "PUT",
        body: { graph: parsed.flow.graph },
      });
      setMissingSecrets(parsed.flow.missingSecrets);
      setImported(created);
      if (parsed.flow.missingSecrets.length === 0) {
        toast.success(`Imported ${created.name}`);
        setImporting(false);
        router.push(`/chatflows/${created.id}`);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  function openCreate() {
    setName("");
    setSlug("");
    setDescription("");
    setCreating(true);
  }

  async function create() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      const created = await adminFetch<FlowDetail>("flows", {
        method: "POST",
        body: {
          name: name.trim(),
          description: description.trim(),
          ...(slug.trim() ? { slug: slug.trim() } : {}),
        },
      });
      toast.success("Chatflow created");
      router.push(`/chatflows/${created.id}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const toggleEnabled = useCallback(
    async (flow: FlowSummary, enabled: boolean) => {
      setBusyId(flow.id);
      try {
        await adminFetch(`flows/${flow.id}`, { method: "PATCH", body: { enabled } });
        router.refresh();
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setBusyId(undefined);
      }
    },
    [router],
  );

  const duplicate = useCallback(
    async (flow: FlowSummary) => {
      setBusyId(flow.id);
      try {
        const copy = await adminFetch<FlowDetail>(`flows/${flow.id}/duplicate`, { method: "POST" });
        toast.success(`Duplicated ${flow.name}`);
        router.push(`/chatflows/${copy.id}`);
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setBusyId(undefined);
      }
    },
    [router],
  );

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await adminFetch(`flows/${deleting.id}`, { method: "DELETE" });
      toast.success(`Deleted ${deleting.name}`);
      setDeleting(undefined);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const columns = useMemo<ColumnDef<FlowSummary, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            <Link
              href={`/chatflows/${row.original.id}`}
              className="font-medium underline-offset-4 hover:underline"
            >
              <TruncatedText text={row.original.name} className="max-w-64" />
            </Link>
            <span className="font-mono text-xs text-muted-foreground">{row.original.slug}</span>
          </div>
        ),
      },
      {
        accessorKey: "description",
        header: "Description",
        enableSorting: false,
        cell: ({ row }) => (
          <TruncatedText
            text={row.original.description || "No description"}
            className="max-w-72 text-muted-foreground"
          />
        ),
      },
      {
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => <Badge variant="outline">{row.original.kind}</Badge>,
      },
      {
        accessorKey: "node_count",
        header: "Nodes",
        cell: ({ row }) => <span className="tabular-nums">{row.original.node_count}</span>,
      },
      {
        accessorKey: "published_version",
        header: "Version",
        cell: ({ row }) =>
          row.original.published_version === null ? (
            <Badge variant="secondary">Draft only</Badge>
          ) : (
            <Badge variant="secondary">v{row.original.published_version}</Badge>
          ),
      },
      {
        accessorKey: "enabled",
        header: "Enabled",
        enableSorting: false,
        cell: ({ row }) => (
          <Switch
            checked={row.original.enabled}
            disabled={busyId === row.original.id}
            onCheckedChange={(checked) => toggleEnabled(row.original, checked)}
            aria-label={`Enable ${row.original.name}`}
          />
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap justify-end gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/chatflows/${row.original.id}`} aria-label={`Edit ${row.original.name}`}>
                Edit
              </Link>
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={`Duplicate ${row.original.name}`}
              disabled={busyId === row.original.id}
              onClick={() => duplicate(row.original)}
            >
              <Copy />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={`Delete ${row.original.name}`}
              onClick={() => setDeleting(row.original)}
            >
              <Trash2 />
            </Button>
          </div>
        ),
      },
    ],
    [busyId, duplicate, toggleEnabled],
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Chatflows"
        description="Design agents and subflows in the visual chatflow editor."
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={openImport}>
              <FileJson />
              Import JSON
            </Button>
            <Button onClick={openCreate}>
              <Plus />
              New chatflow
            </Button>
          </div>
        }
      />

      {flows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
          <Bot className="size-8 text-muted-foreground" />
          <div>
            <p className="font-medium">No chatflows yet</p>
            <p className="text-sm text-muted-foreground">
              Create an agent, build the flow on the canvas and publish it to make it available to
              clients.
            </p>
          </div>
          <Button onClick={openCreate}>
            <Plus />
            New chatflow
          </Button>
        </div>
      ) : (
        <DataTable columns={columns} data={flows} emptyMessage="No chatflows yet." />
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New chatflow</DialogTitle>
            <DialogDescription>
              Agents are published chatflows. You can rename, duplicate and disable them later.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="chatflow-name">Name</Label>
              <Input
                id="chatflow-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Lobby greeter"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="chatflow-slug">Slug (optional)</Label>
              <Input
                id="chatflow-slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="lobby-greeter"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Generated from the name when empty. Fixed once published.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="chatflow-description">Description</Label>
              <Textarea
                id="chatflow-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this agent does, for the agent picker."
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={saving}>
              {saving ? "Creating…" : "Create chatflow"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Import chatflow JSON</DialogTitle>
            <DialogDescription>
              Creates a new chatflow. Exports never contain secrets; re-link webhook headers after
              importing.
            </DialogDescription>
          </DialogHeader>
          {imported ? (
            <div className="space-y-3">
              <p className="text-sm">
                Imported <span className="font-medium">{imported.name}</span>.
              </p>
              {missingSecrets.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-sm font-medium">Re-link these webhook headers:</p>
                  <ul
                    aria-label="Webhook headers to re-link"
                    className="max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-muted-foreground"
                  >
                    {missingSecrets.map((header) => (
                      <li key={header}>{header}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No webhook secrets need re-linking.</p>
              )}
              <DialogFooter>
                <Button onClick={() => router.push(`/chatflows/${imported.id}`)}>
                  Open chatflow
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <Input
                type="file"
                accept="application/json,.json"
                aria-label="Import JSON file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void file
                    .text()
                    .then(setImportText)
                    .catch((error: unknown) => toast.error(errorMessage(error)));
                }}
              />
              <Textarea
                aria-label="Imported chatflow JSON"
                rows={10}
                className="font-mono text-xs"
                placeholder='{"format":"agentx.chatflow","graph":{"nodes":[],"edges":[]}}'
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
              />
              {importErrors.length > 0 && (
                <div role="alert" className="rounded-md border border-destructive/40 p-2 text-xs">
                  <ul className="list-disc space-y-0.5 pl-4">
                    {importErrors.map((message) => (
                      <li key={message} className="break-words text-destructive">
                        {message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {importProblems.length > 0 && (
                <ul className="max-h-32 list-disc space-y-0.5 overflow-y-auto rounded-md border p-2 pl-6 text-xs">
                  {importProblems.map((problem) => (
                    <li
                      key={`${problem.nodeId ?? "flow"}-${problem.message}`}
                      className="break-words"
                    >
                      {problem.nodeTitle ? `${problem.nodeTitle}: ` : ""}
                      {problem.message}
                    </li>
                  ))}
                </ul>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setImporting(false)}>
                  Cancel
                </Button>
                <Button onClick={importFlow} disabled={saving || !importText.trim()}>
                  {saving ? "Importing…" : "Import chatflow"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chatflow?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.name}: its draft, every published version and its webhook secrets are
              deleted. Session transcripts and run logs are kept. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

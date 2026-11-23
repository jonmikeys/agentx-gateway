"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Bot, Copy, Plus, Trash2 } from "lucide-react";
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
import type { FlowDetail, FlowSummary } from "@/lib/agents/types";

export function ChatflowsView({ flows }: { flows: FlowSummary[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [createKind, setCreateKind] = useState<"agent" | "subflow">("agent");
  const [deleting, setDeleting] = useState<FlowSummary | undefined>();
  const [busyId, setBusyId] = useState<string | undefined>();
  const [kindFilter, setKindFilter] = useState<"all" | "agent" | "subflow">("all");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  function openCreate(kind: "agent" | "subflow" = "agent") {
    setCreateKind(kind);
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
          kind: createKind,
          description: description.trim(),
          ...(slug.trim() ? { slug: slug.trim() } : {}),
        },
      });
      toast.success(createKind === "subflow" ? "Subflow created" : "Chatflow created");
      router.push(`/chatflows/${created.id}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const visibleFlows = useMemo(
    () => (kindFilter === "all" ? flows : flows.filter((flow) => flow.kind === kindFilter)),
    [flows, kindFilter],
  );

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
            <Button onClick={() => openCreate("agent")}>
              <Plus />
              New chatflow
            </Button>
            <Button variant="outline" onClick={() => openCreate("subflow")}>
              <Plus />
              New subflow
            </Button>
          </div>
        }
      />

      <fieldset className="flex flex-wrap items-center gap-1">
        <legend className="sr-only">Filter by kind</legend>
        {(
          [
            ["all", "All"],
            ["agent", "Agents"],
            ["subflow", "Subflows"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            variant={kindFilter === value ? "secondary" : "outline"}
            aria-pressed={kindFilter === value}
            onClick={() => setKindFilter(value)}
          >
            {label}
            <span className="text-xs">
              {flows.filter((flow) => value === "all" || flow.kind === value).length}
            </span>
          </Button>
        ))}
      </fieldset>

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
          <Button onClick={() => openCreate("agent")}>
            <Plus />
            New chatflow
          </Button>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={visibleFlows}
          emptyMessage={kindFilter === "all" ? "No chatflows yet." : `No ${kindFilter}s yet.`}
        />
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{createKind === "subflow" ? "New subflow" : "New chatflow"}</DialogTitle>
            <DialogDescription>
              {createKind === "subflow"
                ? "Subflows are reusable flows called from agents or other subflows. They never appear in /v1/agents or /v1/models."
                : "Agents are published chatflows. You can rename, duplicate and disable them later."}
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
              {saving
                ? "Creating…"
                : createKind === "subflow"
                  ? "Create subflow"
                  : "Create chatflow"}
            </Button>
          </DialogFooter>
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

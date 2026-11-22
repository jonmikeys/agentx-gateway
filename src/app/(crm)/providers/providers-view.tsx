"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { CircleCheck, CircleX, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ProviderFormDialog } from "@/app/(crm)/providers/provider-form-dialog";
import { DataTable } from "@/components/crm/data-table";
import { PageHeader } from "@/components/crm/page-header";
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
import { Switch } from "@/components/ui/switch";
import { adminFetch, errorMessage } from "@/lib/admin-client";
import type { ProviderTestResult } from "@/server/gateway/provider-test";
import type { ProviderView } from "@/server/services/providers";

const circuitBadge: Record<
  ProviderView["circuit_state"],
  { label: string; variant: "secondary" | "destructive" | "outline" }
> = {
  closed: { label: "Healthy", variant: "secondary" },
  open: { label: "Circuit open", variant: "destructive" },
  half_open: { label: "Half-open", variant: "outline" },
};

export function ProvidersView({ providers }: { providers: ProviderView[] }) {
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderView | undefined>();
  const [deleting, setDeleting] = useState<ProviderView | undefined>();
  const [testing, setTesting] = useState<string | undefined>();
  const [testResult, setTestResult] = useState<
    { provider: ProviderView; result: ProviderTestResult } | undefined
  >();

  async function toggleEnabled(provider: ProviderView, enabled: boolean) {
    try {
      await adminFetch(`providers/${provider.id}`, { method: "PATCH", body: { enabled } });
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function runTest(provider: ProviderView) {
    setTesting(provider.id);
    try {
      const result = await adminFetch<ProviderTestResult>(`providers/${provider.id}/test`, {
        method: "POST",
      });
      setTestResult({ provider, result });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTesting(undefined);
    }
  }

  async function confirmDelete(provider: ProviderView) {
    try {
      await adminFetch(`providers/${provider.id}`, { method: "DELETE" });
      toast.success(`Deleted ${provider.name}`);
      setDeleting(undefined);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const columns = useMemo<ColumnDef<ProviderView, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        accessorKey: "base_url",
        header: "Base URL",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">{row.original.base_url}</span>
        ),
      },
      {
        id: "enabled",
        header: "Enabled",
        enableSorting: false,
        cell: ({ row }) => (
          <Switch
            aria-label={`Enable ${row.original.name}`}
            checked={row.original.enabled}
            onCheckedChange={(checked) => toggleEnabled(row.original, checked)}
          />
        ),
      },
      {
        id: "capabilities",
        header: "Capabilities",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {Object.entries(row.original.capabilities)
              .filter(([, on]) => on)
              .map(([name]) => (
                <Badge key={name} variant="outline">
                  {name}
                </Badge>
              ))}
          </div>
        ),
      },
      {
        id: "circuit",
        header: "Circuit",
        enableSorting: false,
        cell: ({ row }) => {
          const badge = circuitBadge[row.original.circuit_state];
          return <Badge variant={badge.variant}>{badge.label}</Badge>;
        },
      },
      {
        id: "key",
        header: "API key",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.api_key_masked ?? "none"}</span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={testing === row.original.id}
              onClick={() => runTest(row.original)}
            >
              <Zap />
              {testing === row.original.id ? "Testing..." : "Test connection"}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Edit ${row.original.name}`}
              onClick={() => {
                setEditing(row.original);
                setFormOpen(true);
              }}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${row.original.name}`}
              onClick={() => setDeleting(row.original)}
            >
              <Trash2 />
            </Button>
          </div>
        ),
      },
    ],
    [testing],
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Providers"
        description="Upstream LLM provider endpoints, keys and health."
        action={
          <Button
            onClick={() => {
              setEditing(undefined);
              setFormOpen(true);
            }}
          >
            <Plus />
            New provider
          </Button>
        }
      />
      <DataTable
        columns={columns}
        data={providers}
        emptyMessage="No providers yet. Add an OpenAI-compatible endpoint to get started."
      />

      <ProviderFormDialog open={formOpen} provider={editing} onOpenChange={setFormOpen} />

      <Dialog open={testResult !== undefined} onOpenChange={() => setTestResult(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {testResult?.result.ok ? (
                <CircleCheck className="size-5 text-primary" />
              ) : (
                <CircleX className="size-5 text-destructive" />
              )}
              Connection {testResult?.result.ok ? "succeeded" : "failed"}
            </DialogTitle>
            <DialogDescription>{testResult?.provider.name}</DialogDescription>
          </DialogHeader>
          {testResult && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Latency</dt>
              <dd>{testResult.result.latency_ms} ms</dd>
              {testResult.result.ok ? (
                <>
                  <dt className="text-muted-foreground">Models</dt>
                  <dd>{testResult.result.model_count}</dd>
                  <dt className="text-muted-foreground">Sample</dt>
                  <dd className="font-mono text-xs">
                    {testResult.result.models.slice(0, 8).join(", ") || "none"}
                  </dd>
                </>
              ) : (
                <>
                  <dt className="text-muted-foreground">Error</dt>
                  <dd>{testResult.result.error}</dd>
                </>
              )}
            </dl>
          )}
          <DialogFooter>
            <Button onClick={() => setTestResult(undefined)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== undefined} onOpenChange={() => setDeleting(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleting?.used_by_routes.length ? "Provider is in use" : `Delete ${deleting?.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.used_by_routes.length
                ? `${deleting.name} is used by the route(s) ${deleting.used_by_routes.join(", ")}. Remove it from those routes first.`
                : "This removes the provider and its stored key. It cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {deleting?.used_by_routes.length ? "Close" : "Cancel"}
            </AlertDialogCancel>
            {deleting && deleting.used_by_routes.length === 0 && (
              <AlertDialogAction variant="destructive" onClick={() => confirmDelete(deleting)}>
                Delete
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

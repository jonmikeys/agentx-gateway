"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { RouteEditorDialog } from "@/app/(crm)/routes/route-editor-dialog";
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
import { Switch } from "@/components/ui/switch";
import { adminFetch, errorMessage } from "@/lib/admin-client";
import type { ProviderView } from "@/server/services/providers";
import type { RouteView } from "@/server/services/routes";

export function RoutesView({
  routes,
  providers,
}: {
  routes: RouteView[];
  providers: ProviderView[];
}) {
  const router = useRouter();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<RouteView | undefined>();
  const [deleting, setDeleting] = useState<RouteView | undefined>();

  const run = useCallback(
    async (action: () => Promise<unknown>, success: string) => {
      try {
        await action();
        toast.success(success);
        router.refresh();
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [router],
  );

  const toggleEnabled = useCallback(
    (route: RouteView, enabled: boolean) =>
      run(
        () =>
          adminFetch(`routes/${route.id}`, {
            method: "PUT",
            body: {
              slug: route.slug,
              description: route.description,
              enabled,
              steps: route.steps.map((step) => ({
                provider_id: step.provider_id,
                upstream_model: step.upstream_model,
                timeout_ms: step.timeout_ms,
              })),
            },
          }),
        enabled ? "Route enabled" : "Route disabled",
      ),
    [run],
  );

  // Stable column definitions: TanStack renders cells as components, so a new array on every
  // render would remount the row buttons and drop keyboard focus.
  const columns = useMemo<ColumnDef<RouteView, unknown>[]>(
    () => [
      {
        accessorKey: "slug",
        header: "Slug",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={
                row.original.is_default
                  ? `${row.original.slug} is the default route`
                  : `Make ${row.original.slug} the default route`
              }
              aria-pressed={row.original.is_default}
              disabled={row.original.is_default || !row.original.enabled}
              onClick={() =>
                run(
                  () => adminFetch(`routes/${row.original.id}/default`, { method: "POST" }),
                  `${row.original.slug} is now the default route`,
                )
              }
            >
              <Star
                className={
                  row.original.is_default ? "fill-current text-primary" : "text-muted-foreground"
                }
              />
            </Button>
            <TruncatedText text={row.original.slug} className="max-w-56 font-medium" />
            {row.original.is_default && <Badge variant="secondary">Default</Badge>}
          </div>
        ),
      },
      {
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <TruncatedText
            text={row.original.description || "-"}
            className="max-w-80 text-muted-foreground"
          />
        ),
      },
      {
        id: "steps",
        header: "Failover chain",
        enableSorting: false,
        cell: ({ row }) => (
          <ol className="flex flex-col gap-1 text-xs">
            {row.original.steps.map((step, index) => (
              <li key={step.position} className="flex items-center gap-1.5">
                <span className="w-4 shrink-0 text-right text-muted-foreground">{index + 1}</span>
                <Badge variant="outline" className="max-w-56">
                  <TruncatedText text={`${step.provider_name} / ${step.upstream_model}`} />
                </Badge>
              </li>
            ))}
          </ol>
        ),
      },
      {
        id: "enabled",
        header: "Enabled",
        enableSorting: false,
        cell: ({ row }) => (
          <Switch
            aria-label={`Enable ${row.original.slug}`}
            checked={row.original.enabled}
            disabled={row.original.is_default}
            onCheckedChange={(checked) => toggleEnabled(row.original, checked)}
          />
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Edit ${row.original.slug}`}
              onClick={() => {
                setEditing(row.original);
                setEditorOpen(true);
              }}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${row.original.slug}`}
              onClick={() => setDeleting(row.original)}
            >
              <Trash2 />
            </Button>
          </div>
        ),
      },
    ],
    [run, toggleEnabled],
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Model Routes"
        description="Route model names to ordered provider steps with failover."
        action={
          <Button
            disabled={providers.length === 0}
            onClick={() => {
              setEditing(undefined);
              setEditorOpen(true);
            }}
          >
            <Plus />
            New route
          </Button>
        }
      />
      {providers.length === 0 && (
        <p className="text-sm text-muted-foreground">Add a provider first, then create a route.</p>
      )}
      <DataTable
        columns={columns}
        data={routes}
        emptyMessage="No routes yet. Clients send a route slug as the model name."
      />

      <RouteEditorDialog
        open={editorOpen}
        route={editing}
        providers={providers}
        onOpenChange={setEditorOpen}
      />

      <AlertDialog open={deleting !== undefined} onOpenChange={() => setDeleting(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.slug}?</AlertDialogTitle>
            <AlertDialogDescription>
              Clients using this model name will get model_not_found. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = deleting;
                setDeleting(undefined);
                if (target) {
                  void run(
                    () => adminFetch(`routes/${target.id}`, { method: "DELETE" }),
                    `Deleted ${target.slug}`,
                  );
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

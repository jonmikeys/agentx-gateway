"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Check, Copy, KeyRound, Pencil, Plus, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiKeyFormDialog } from "@/app/(crm)/api-keys/api-key-form-dialog";
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
import { adminFetch, errorMessage, formatTimestamp } from "@/lib/admin-client";
import type { ApiKeyView } from "@/server/services/api-keys";

function limitText(value: number | null): string {
  return value === null ? "Unlimited" : value.toLocaleString("en-US");
}

export function ApiKeysView({ apiKeys }: { apiKeys: ApiKeyView[] }) {
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ApiKeyView | undefined>();
  const [revoking, setRevoking] = useState<ApiKeyView | undefined>();
  const [created, setCreated] = useState<{ key: string; label: string } | undefined>();
  const [copied, setCopied] = useState(false);

  async function copyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy. Select the key and copy it manually.");
    }
  }

  async function confirmRevoke(apiKey: ApiKeyView) {
    try {
      await adminFetch(`api-keys/${apiKey.id}/revoke`, { method: "POST" });
      toast.success(`Revoked ${apiKey.label}`);
      setRevoking(undefined);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const columns = useMemo<ColumnDef<ApiKeyView, unknown>[]>(
    () => [
      {
        accessorKey: "label",
        header: "Label",
        cell: ({ row }) => <span className="font-medium">{row.original.label}</span>,
      },
      {
        accessorKey: "key_prefix",
        header: "Key",
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.key_prefix}...</span>,
      },
      {
        accessorKey: "last_used_at",
        header: "Last used",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatTimestamp(row.original.last_used_at)}
          </span>
        ),
      },
      {
        id: "limits",
        header: "Limits",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="text-xs text-muted-foreground">
            <div>{limitText(row.original.rpm_limit)} req/min</div>
            <div>{limitText(row.original.tokens_per_day_limit)} tokens/day</div>
          </div>
        ),
      },
      {
        id: "allowlist",
        header: "IP allowlist",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.ip_allowlist.length === 0 ? (
            <span className="text-muted-foreground">Any</span>
          ) : (
            <span className="font-mono text-xs">{row.original.ip_allowlist.join(", ")}</span>
          ),
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.revoked_at ? (
            <Badge variant="destructive">Revoked</Badge>
          ) : (
            <Badge variant="secondary">Active</Badge>
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
              aria-label={`Edit ${row.original.label}`}
              disabled={row.original.revoked_at !== null}
              onClick={() => {
                setEditing(row.original);
                setFormOpen(true);
              }}
            >
              <Pencil />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={row.original.revoked_at !== null}
              onClick={() => setRevoking(row.original)}
            >
              Revoke
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="API Keys"
        description="Issue, label and revoke client API keys."
        action={
          <Button
            onClick={() => {
              setEditing(undefined);
              setFormOpen(true);
            }}
          >
            <Plus />
            New API key
          </Button>
        }
      />
      <DataTable
        columns={columns}
        data={apiKeys}
        emptyMessage="No API keys yet. Create one for each client, such as the Unity app."
      />

      <ApiKeyFormDialog
        open={formOpen}
        apiKey={editing}
        onOpenChange={setFormOpen}
        onCreated={(key, label) => {
          setCopied(false);
          setCreated({ key, label });
        }}
      />

      <Dialog open={created !== undefined} onOpenChange={() => setCreated(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-5" />
              API key created
            </DialogTitle>
            <DialogDescription>{created?.label}</DialogDescription>
          </DialogHeader>
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            Copy this key now. It won't be shown again; only a hash is stored.
          </div>
          <div className="flex items-center gap-2">
            <code
              data-testid="created-api-key"
              className="flex-1 overflow-x-auto rounded-lg border bg-muted px-3 py-2 font-mono text-sm"
            >
              {created?.key}
            </code>
            <Button variant="outline" onClick={() => created && copyKey(created.key)}>
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setCreated(undefined)}>I have saved the key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={revoking !== undefined} onOpenChange={() => setRevoking(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Clients using this key will immediately get 401 invalid_api_key. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => revoking && confirmRevoke(revoking)}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

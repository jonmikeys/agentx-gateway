"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { CircleCheck, CircleX, Pencil, Plus, RefreshCw, Trash2, Wrench, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { McpServerDialog } from "@/app/(crm)/mcp/mcp-server-dialog";
import { McpToolsDialog } from "@/app/(crm)/mcp/mcp-tools-dialog";
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
import { Switch } from "@/components/ui/switch";
import { adminFetch, errorMessage } from "@/lib/admin-client";
import type { McpServerView, McpToolTestResult, McpToolView } from "@/server/services/mcp";

export function McpView({ servers, tools }: { servers: McpServerView[]; tools: McpToolView[] }) {
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerView | undefined>();
  const [deleting, setDeleting] = useState<McpServerView | undefined>();
  const [toolsServer, setToolsServer] = useState<McpServerView | undefined>();
  const [testing, setTesting] = useState<string | undefined>();
  const [testResult, setTestResult] = useState<
    { server: McpServerView; result: McpToolTestResult } | undefined
  >();
  const [refreshing, setRefreshing] = useState<string | undefined>();
  const lastTestedId = useRef<string | undefined>(undefined);

  const toggleEnabled = useCallback(
    async (server: McpServerView, enabled: boolean) => {
      try {
        await adminFetch(`mcp-servers/${server.id}`, { method: "PATCH", body: { enabled } });
        router.refresh();
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [router],
  );

  const runTest = useCallback(async (server: McpServerView) => {
    lastTestedId.current = server.id;
    setTesting(server.id);
    try {
      const result = await adminFetch<McpToolTestResult>(`mcp-servers/${server.id}/test`, {
        method: "POST",
      });
      setTestResult({ server, result });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTesting(undefined);
    }
  }, []);

  const refreshTools = useCallback(
    async (server: McpServerView) => {
      setRefreshing(server.id);
      try {
        const result = await adminFetch<{ data: McpToolView[] }>(
          `mcp-servers/${server.id}/refresh-tools`,
          { method: "POST" },
        );
        toast.success(`Fetched ${result.data.length} tools from ${server.name}`);
        router.refresh();
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setRefreshing(undefined);
      }
    },
    [router],
  );

  async function confirmDelete(server: McpServerView) {
    try {
      await adminFetch(`mcp-servers/${server.id}`, { method: "DELETE" });
      toast.success(`Deleted ${server.name}`);
      setDeleting(undefined);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const columns = useMemo<ColumnDef<McpServerView, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <TruncatedText text={row.original.name} className="max-w-64 font-medium" />
            <span className="font-mono text-xs text-muted-foreground">{row.original.slug}</span>
          </div>
        ),
      },
      {
        accessorKey: "url",
        header: "URL",
        cell: ({ row }) => (
          <TruncatedText
            text={row.original.url}
            className="max-w-72 font-mono text-xs text-muted-foreground"
          />
        ),
      },
      {
        accessorKey: "transport",
        header: "Transport",
        cell: ({ row }) => (
          <Badge variant="outline">{row.original.transport.replace("_", " ")}</Badge>
        ),
      },
      {
        id: "tools",
        header: "Tools",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-sm">
            {row.original.allowed_tool_count} / {row.original.tool_count} allowed
          </span>
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
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={testing === row.original.id}
              data-test-mcp={row.original.id}
              onClick={() => runTest(row.original)}
            >
              <Zap />
              <span className="sr-only xl:not-sr-only">Test</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Refresh tools for ${row.original.name}`}
              disabled={refreshing === row.original.id}
              onClick={() => refreshTools(row.original)}
            >
              <RefreshCw />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Browse tools for ${row.original.name}`}
              onClick={() => setToolsServer(row.original)}
            >
              <Wrench />
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
    [refreshing, refreshTools, runTest, testing, toggleEnabled],
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="MCP Servers"
        description="External MCP servers and the tools the avatar may call."
        action={
          <Button
            onClick={() => {
              setEditing(undefined);
              setFormOpen(true);
            }}
          >
            <Plus />
            New MCP server
          </Button>
        }
      />
      <DataTable
        columns={columns}
        data={servers}
        emptyMessage="No MCP servers yet. Add Composio or another Model Context Protocol server."
      />

      <McpServerDialog open={formOpen} server={editing} onOpenChange={setFormOpen} />

      <McpToolsDialog
        server={toolsServer}
        tools={tools}
        onOpenChange={(open) => {
          if (!open) setToolsServer(undefined);
        }}
      />

      <Dialog open={testResult !== undefined} onOpenChange={() => setTestResult(undefined)}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document
              .querySelector<HTMLElement>(`[data-test-mcp="${lastTestedId.current}"]`)
              ?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {testResult?.result.ok ? (
                <CircleCheck className="size-5 text-primary" />
              ) : (
                <CircleX className="size-5 text-destructive" />
              )}
              Connection {testResult?.result.ok ? "succeeded" : "failed"}
            </DialogTitle>
            <DialogDescription className="break-words">{testResult?.server.name}</DialogDescription>
          </DialogHeader>
          {testResult && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Latency</dt>
              <dd>{testResult.result.duration_ms} ms</dd>
              {testResult.result.ok ? (
                <>
                  <dt className="text-muted-foreground">Tools</dt>
                  <dd>{testResult.result.tools?.length ?? 0}</dd>
                  <dt className="text-muted-foreground">Sample</dt>
                  <dd className="min-w-0 font-mono text-xs break-words">
                    {testResult.result.tools
                      ?.slice(0, 8)
                      .map((tool) => tool.name)
                      .join(", ") || "none"}
                  </dd>
                </>
              ) : (
                <>
                  <dt className="text-muted-foreground">Error</dt>
                  <dd className="break-words">{testResult.result.error}</dd>
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
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the server, its tool catalogue and its route selections. It cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) void confirmDelete(deleting);
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

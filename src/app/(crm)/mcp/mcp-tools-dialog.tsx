"use client";

import { ChevronDown, RefreshCw, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import type { McpServerView, McpToolView } from "@/server/services/mcp";

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export function McpToolsDialog({
  server,
  tools,
  onOpenChange,
}: {
  server: McpServerView | undefined;
  tools: McpToolView[];
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | undefined>();
  const visible = server ? tools.filter((tool) => tool.server_id === server.id) : [];

  async function toggle(tool: McpToolView, allowed: boolean) {
    setBusy(tool.id);
    try {
      await adminFetch(`mcp-tools/${tool.id}`, { method: "PATCH", body: { allowed } });
      toast.success(allowed ? `Allowed ${tool.exposed_name}` : `Blocked ${tool.exposed_name}`);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function refresh() {
    if (!server) return;
    setBusy(server.id);
    try {
      const result = await adminFetch<{ data: McpToolView[] }>(
        `mcp-servers/${server.id}/refresh-tools`,
        { method: "POST" },
      );
      toast.success(`Fetched ${result.data.length} tools`);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Dialog open={server !== undefined} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="size-5 text-muted-foreground" />
            Tools on {server?.name}
          </DialogTitle>
          <DialogDescription>
            Tick the tools models may call. Exposed names are{" "}
            <code>&lt;server_slug&gt;__&lt;tool&gt;</code>.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {visible.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No tools fetched yet. Refresh to query the server.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {visible.map((tool) => (
                <li key={tool.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Switch
                      aria-label={`Allow ${tool.exposed_name}`}
                      checked={tool.allowed}
                      disabled={busy === tool.id}
                      onCheckedChange={(checked) => toggle(tool, checked)}
                    />
                    <span className="font-mono text-sm font-medium">{tool.exposed_name}</span>
                    {!tool.valid && <Badge variant="destructive">Invalid name</Badge>}
                    <Badge variant="outline" className="ml-auto">
                      {tool.allowed ? "Allowed" : "Blocked"}
                    </Badge>
                  </div>
                  {tool.description && (
                    <p className="mt-1 text-xs text-muted-foreground break-words">
                      {tool.description}
                    </p>
                  )}
                  <Collapsible className="mt-2">
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="xs" className="group">
                        <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
                        Schema preview
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <pre className="mt-2 rounded-md bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">
                        {prettyJson(tool.input_schema)}
                      </pre>
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy === server?.id} onClick={refresh}>
            <RefreshCw />
            {busy === server?.id ? "Refreshing..." : "Refresh tools"}
          </Button>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

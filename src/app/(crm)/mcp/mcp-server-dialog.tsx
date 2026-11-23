"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { adminFetch, errorMessage } from "@/lib/admin-client";
import { mcpServerCreateSchema, mcpTransportSchema } from "@/lib/gateway-schemas";
import type { McpServerView } from "@/server/services/mcp";

const formSchema = z.object({
  name: mcpServerCreateSchema.shape.name,
  slug: mcpServerCreateSchema.shape.slug,
  url: mcpServerCreateSchema.shape.url,
  transport: mcpTransportSchema,
  headers: z.string(),
  clear_headers: z.boolean(),
  enabled: z.boolean(),
});

type FormValues = z.infer<typeof formSchema>;

const emptyValues: FormValues = {
  name: "",
  slug: "",
  url: "",
  transport: "streamable_http",
  headers: "",
  clear_headers: false,
  enabled: true,
};

/** Parses `Name: value` lines. Returns undefined when a line is malformed. */
function parseHeaderLines(text: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) return undefined;
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return headers;
}

export function McpServerDialog({
  open,
  server,
  onOpenChange,
}: {
  open: boolean;
  /** The server being edited, or undefined to create one. */
  server?: McpServerView;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: emptyValues });

  useEffect(() => {
    if (!open) return;
    reset(
      server
        ? {
            ...emptyValues,
            name: server.name,
            slug: server.slug,
            url: server.url,
            transport: server.transport,
            enabled: server.enabled,
          }
        : emptyValues,
    );
  }, [open, server, reset]);

  async function onSubmit(values: FormValues) {
    const headers = parseHeaderLines(values.headers);
    if (!headers) {
      setError("headers", { message: "Use one 'Header-Name: value' per line" });
      return;
    }
    const payload: Record<string, unknown> = {
      name: values.name,
      slug: values.slug,
      url: values.url,
      transport: values.transport,
      enabled: values.enabled,
    };
    // Headers are write-only: absent keeps the stored value, null clears it.
    if (Object.keys(headers).length > 0) payload.headers = headers;
    else if (values.clear_headers) payload.headers = null;

    try {
      await adminFetch(server ? `mcp-servers/${server.id}` : "mcp-servers", {
        method: server ? "PATCH" : "POST",
        body: payload,
      });
      toast.success(server ? "MCP server updated" : "MCP server created");
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const editing = server !== undefined;
  const storedHeaders = server?.headers_masked?.map((header) => header.name).join(", ") ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${server.name}` : "New MCP server"}</DialogTitle>
          <DialogDescription>
            An external Model Context Protocol server. Its slug prefixes every tool name offered to
            models; headers are encrypted at rest and never shown again.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.name}>
                <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
                <Input id="mcp-name" placeholder="Composio" {...register("name")} />
                <FieldError errors={[errors.name]} />
              </Field>
              <Field data-invalid={!!errors.slug}>
                <FieldLabel htmlFor="mcp-slug">Slug</FieldLabel>
                <Input id="mcp-slug" placeholder="composio" {...register("slug")} />
                <FieldError errors={[errors.slug]} />
              </Field>
            </div>
            <Field data-invalid={!!errors.url}>
              <FieldLabel htmlFor="mcp-url">Server URL</FieldLabel>
              <Input id="mcp-url" placeholder="https://mcp.composio.dev/..." {...register("url")} />
              <FieldDescription>
                Streamable HTTP is tried first; choose SSE for servers that only expose it.
              </FieldDescription>
              <FieldError errors={[errors.url]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="mcp-transport">Transport</FieldLabel>
              <Controller
                control={control}
                name="transport"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="mcp-transport" className="w-full" aria-label="Transport">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="streamable_http">Streamable HTTP</SelectItem>
                      <SelectItem value="sse">SSE</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field data-invalid={!!errors.headers}>
              <FieldLabel htmlFor="mcp-headers">Headers</FieldLabel>
              <Textarea
                id="mcp-headers"
                rows={3}
                className="font-mono text-xs"
                placeholder={
                  storedHeaders
                    ? `Stored: ${storedHeaders} (leave blank to keep)`
                    : "x-api-key: your-key\nx-user-id: user@example.com"
                }
                {...register("headers")}
              />
              <FieldDescription>
                Write-only. Values are encrypted; leave blank to keep the stored headers.
              </FieldDescription>
              <FieldError errors={[errors.headers]} />
              {editing && storedHeaders && (
                <Controller
                  control={control}
                  name="clear_headers"
                  render={({ field }) => (
                    <div className="flex items-center gap-2">
                      <Switch
                        id="mcp-clear-headers"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        size="sm"
                      />
                      <Label htmlFor="mcp-clear-headers" className="font-normal">
                        Remove the stored headers
                      </Label>
                    </div>
                  )}
                />
              )}
            </Field>
            <Controller
              control={control}
              name="enabled"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Switch id="mcp-enabled" checked={field.value} onCheckedChange={field.onChange} />
                  <FieldLabel htmlFor="mcp-enabled">Enabled</FieldLabel>
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {editing ? "Save changes" : "Create server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

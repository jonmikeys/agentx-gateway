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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { adminFetch, errorMessage } from "@/lib/admin-client";
import { providerCreateSchema } from "@/lib/gateway-schemas";
import type { ProviderView } from "@/server/services/providers";

const formSchema = z.object({
  name: providerCreateSchema.shape.name,
  base_url: providerCreateSchema.shape.base_url,
  api_key: z.string(),
  clear_api_key: z.boolean(),
  extra_headers: z.string(),
  clear_extra_headers: z.boolean(),
  enabled: z.boolean(),
  streaming: z.boolean(),
  tools: z.boolean(),
  responses_api: z.boolean(),
});

type FormValues = z.infer<typeof formSchema>;

const emptyValues: FormValues = {
  name: "",
  base_url: "",
  api_key: "",
  clear_api_key: false,
  extra_headers: "",
  clear_extra_headers: false,
  enabled: true,
  streaming: true,
  tools: true,
  responses_api: false,
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

export function ProviderFormDialog({
  open,
  provider,
  onOpenChange,
}: {
  open: boolean;
  /** The provider being edited, or undefined to create a new one. */
  provider?: ProviderView;
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
      provider
        ? {
            ...emptyValues,
            name: provider.name,
            base_url: provider.base_url,
            enabled: provider.enabled,
            ...provider.capabilities,
          }
        : emptyValues,
    );
  }, [open, provider, reset]);

  async function onSubmit(values: FormValues) {
    const headers = parseHeaderLines(values.extra_headers);
    if (!headers) {
      setError("extra_headers", { message: "Use one 'Header-Name: value' per line" });
      return;
    }
    const payload: Record<string, unknown> = {
      name: values.name,
      base_url: values.base_url,
      enabled: values.enabled,
      capabilities: {
        streaming: values.streaming,
        tools: values.tools,
        responses_api: values.responses_api,
      },
    };
    // Secrets are write-only: absent keeps the stored value, null clears it.
    if (values.api_key.trim()) payload.api_key = values.api_key.trim();
    else if (values.clear_api_key) payload.api_key = null;
    if (Object.keys(headers).length > 0) payload.extra_headers = headers;
    else if (values.clear_extra_headers) payload.extra_headers = null;

    try {
      await adminFetch(provider ? `providers/${provider.id}` : "providers", {
        method: provider ? "PATCH" : "POST",
        body: payload,
      });
      toast.success(provider ? "Provider updated" : "Provider created");
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const editing = provider !== undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${provider.name}` : "New provider"}</DialogTitle>
          <DialogDescription>
            An OpenAI-compatible upstream. Keys are encrypted at rest and never shown again.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="provider-name">Name</FieldLabel>
              <Input id="provider-name" placeholder="OpenAI" {...register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.base_url}>
              <FieldLabel htmlFor="provider-base-url">Base URL</FieldLabel>
              <Input
                id="provider-base-url"
                placeholder="https://api.openai.com/v1"
                {...register("base_url")}
              />
              <FieldDescription>
                The gateway calls {"{base URL}"}/chat/completions and /models.
              </FieldDescription>
              <FieldError errors={[errors.base_url]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-api-key">API key</FieldLabel>
              <Input
                id="provider-api-key"
                type="password"
                autoComplete="off"
                placeholder={
                  editing && provider.api_key_masked
                    ? `Stored: ${provider.api_key_masked} (leave blank to keep)`
                    : "Optional for keyless local servers"
                }
                {...register("api_key")}
              />
              {editing && provider.api_key_masked && (
                <Controller
                  control={control}
                  name="clear_api_key"
                  render={({ field }) => (
                    <label className="flex items-center gap-2 text-sm">
                      <Switch checked={field.value} onCheckedChange={field.onChange} size="sm" />
                      Remove the stored key
                    </label>
                  )}
                />
              )}
            </Field>
            <Field data-invalid={!!errors.extra_headers}>
              <FieldLabel htmlFor="provider-headers">Extra headers</FieldLabel>
              <Textarea
                id="provider-headers"
                rows={3}
                className="font-mono text-xs"
                placeholder={
                  editing && provider.extra_header_names.length > 0
                    ? `Stored: ${provider.extra_header_names.join(", ")} (leave blank to keep)`
                    : "X-Org-Id: abc123"
                }
                {...register("extra_headers")}
              />
              <FieldError errors={[errors.extra_headers]} />
              {editing && provider.extra_header_names.length > 0 && (
                <Controller
                  control={control}
                  name="clear_extra_headers"
                  render={({ field }) => (
                    <label className="flex items-center gap-2 text-sm">
                      <Switch checked={field.value} onCheckedChange={field.onChange} size="sm" />
                      Remove the stored headers
                    </label>
                  )}
                />
              )}
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["enabled", "Enabled"],
                  ["streaming", "Streaming"],
                  ["tools", "Tools"],
                ] as const
              ).map(([name, label]) => (
                <Controller
                  key={name}
                  control={control}
                  name={name}
                  render={({ field }) => (
                    <Field orientation="horizontal">
                      <Switch
                        id={`provider-${name}`}
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                      <FieldLabel htmlFor={`provider-${name}`}>{label}</FieldLabel>
                    </Field>
                  )}
                />
              ))}
            </div>
            <Controller
              control={control}
              name="responses_api"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Switch
                    id="provider-responses_api"
                    aria-describedby="provider-responses_api-help"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="provider-responses_api">Responses API</FieldLabel>
                    <FieldDescription id="provider-responses_api-help">
                      Turn on when this endpoint implements <code>POST /responses</code> (OpenAI and
                      compatible servers). <code>/v1/responses</code> requests then go to it
                      natively, unchanged. Leave off for chat-only servers (DeepSeek, Ollama,
                      Groq...): the gateway translates to <code>/chat/completions</code> and back.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {editing ? "Save changes" : "Create provider"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

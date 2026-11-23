"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
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
import { Textarea } from "@/components/ui/textarea";
import { adminFetch, errorMessage } from "@/lib/admin-client";
import { apiKeyCreateSchema } from "@/lib/gateway-schemas";
import { isValidCidr } from "@/server/gateway/cidr";
import type { ApiKeyView } from "@/server/services/api-keys";

const optionalLimit = z
  .string()
  .trim()
  .refine(
    (value) => value === "" || /^[1-9]\d*$/.test(value),
    "Enter a whole number or leave empty",
  );

const formSchema = z.object({
  label: apiKeyCreateSchema.shape.label,
  ip_allowlist: z.string().refine(
    (value) =>
      value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .every(isValidCidr),
    "One valid IP or CIDR range per line (for example 203.0.113.0/24)",
  ),
  rpm_limit: optionalLimit,
  tokens_per_day_limit: optionalLimit,
});

type FormValues = z.infer<typeof formSchema>;

const emptyValues: FormValues = {
  label: "",
  ip_allowlist: "",
  rpm_limit: "",
  tokens_per_day_limit: "",
};

export function ApiKeyFormDialog({
  open,
  apiKey,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  /** The key being edited, or undefined to create a new one. */
  apiKey?: ApiKeyView;
  onOpenChange: (open: boolean) => void;
  /** Called with the plaintext key, exactly once, after creation. */
  onCreated: (key: string, label: string) => void;
}) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: emptyValues });

  useEffect(() => {
    if (!open) return;
    reset(
      apiKey
        ? {
            label: apiKey.label,
            ip_allowlist: apiKey.ip_allowlist.join("\n"),
            rpm_limit: apiKey.rpm_limit?.toString() ?? "",
            tokens_per_day_limit: apiKey.tokens_per_day_limit?.toString() ?? "",
          }
        : emptyValues,
    );
  }, [open, apiKey, reset]);

  async function onSubmit(values: FormValues) {
    const payload = {
      label: values.label,
      ip_allowlist: values.ip_allowlist
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      rpm_limit: values.rpm_limit ? Number(values.rpm_limit) : null,
      tokens_per_day_limit: values.tokens_per_day_limit
        ? Number(values.tokens_per_day_limit)
        : null,
    };
    try {
      if (apiKey) {
        await adminFetch(`api-keys/${apiKey.id}`, { method: "PATCH", body: payload });
        toast.success("API key updated");
      } else {
        const created = await adminFetch<{ key: string }>("api-keys", {
          method: "POST",
          body: payload,
        });
        onCreated(created.key, values.label);
      }
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{apiKey ? `Edit ${apiKey.label}` : "New API key"}</DialogTitle>
          <DialogDescription>
            {apiKey
              ? "The key itself cannot be changed or shown again."
              : "The full key is shown once after creation."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <FieldGroup>
            <Field data-invalid={!!errors.label}>
              <FieldLabel htmlFor="key-label">Label</FieldLabel>
              <Input id="key-label" placeholder="Lobby kiosk" {...register("label")} />
              <FieldError errors={[errors.label]} />
            </Field>
            <Field data-invalid={!!errors.ip_allowlist}>
              <FieldLabel htmlFor="key-allowlist">IP allowlist</FieldLabel>
              <Textarea
                id="key-allowlist"
                rows={3}
                className="font-mono text-xs"
                placeholder={"203.0.113.0/24\n2001:db8::/32"}
                {...register("ip_allowlist")}
              />
              <FieldDescription>
                Empty allows any address. Needs a reverse proxy that sets X-Forwarded-For (see
                docs/api-keys.md).
              </FieldDescription>
              <FieldError errors={[errors.ip_allowlist]} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.rpm_limit}>
                <FieldLabel htmlFor="key-rpm">Requests per minute</FieldLabel>
                <Input
                  id="key-rpm"
                  inputMode="numeric"
                  placeholder="Unlimited"
                  {...register("rpm_limit")}
                />
                <FieldError errors={[errors.rpm_limit]} />
              </Field>
              <Field data-invalid={!!errors.tokens_per_day_limit}>
                <FieldLabel htmlFor="key-tokens">Tokens per day</FieldLabel>
                <Input
                  id="key-tokens"
                  inputMode="numeric"
                  placeholder="Unlimited"
                  {...register("tokens_per_day_limit")}
                />
                <FieldError errors={[errors.tokens_per_day_limit]} />
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {apiKey ? "Save changes" : "Create key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

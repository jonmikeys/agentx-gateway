"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { PageHeader } from "@/components/crm/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { adminFetch, errorMessage } from "@/lib/admin-client";
import { sessionSettingsSchema } from "@/lib/gateway-schemas";
import type { SessionSettings } from "@/lib/session-types";

type FormInput = z.input<typeof sessionSettingsSchema>;

export function SettingsView({ initial }: { initial: SessionSettings }) {
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormInput, unknown, SessionSettings>({
    resolver: zodResolver(sessionSettingsSchema),
    defaultValues: initial,
  });

  async function onSubmit(values: SessionSettings) {
    try {
      const saved = await adminFetch<SessionSettings>("settings", { method: "PUT", body: values });
      reset(saved);
      toast.success("Settings saved");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Session idle timeout, retention and other defaults."
      />
      <form onSubmit={handleSubmit(onSubmit)} className="max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>Sessions and transcripts</CardTitle>
            <CardDescription>
              Applies to every client of the chat API. Changes take effect within a few seconds.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field data-invalid={errors.idle_timeout_minutes ? true : undefined}>
                <FieldLabel htmlFor="idle_timeout_minutes">Idle timeout (minutes)</FieldLabel>
                <Input
                  id="idle_timeout_minutes"
                  type="number"
                  min={1}
                  className="w-40"
                  {...register("idle_timeout_minutes")}
                />
                <FieldDescription>
                  A session with no request for this long expires. The client's next request with
                  that session id gets 404 session_not_found and starts a new conversation.
                </FieldDescription>
                <FieldError errors={[errors.idle_timeout_minutes]} />
              </Field>

              <Field data-invalid={errors.retention_days ? true : undefined}>
                <FieldLabel htmlFor="retention_days">Retention (days)</FieldLabel>
                <Input
                  id="retention_days"
                  type="number"
                  min={0}
                  className="w-40"
                  {...register("retention_days")}
                />
                <FieldDescription>
                  Sessions with no activity for this many days are deleted hourly, with their
                  transcripts and request logs. Use 0 to keep everything forever.
                </FieldDescription>
                <FieldError errors={[errors.retention_days]} />
              </Field>

              <Field orientation="horizontal">
                <Controller
                  control={control}
                  name="redaction_enabled"
                  render={({ field }) => (
                    <Switch
                      id="redaction_enabled"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
                <div className="flex flex-col gap-1">
                  <FieldLabel htmlFor="redaction_enabled">
                    Redact emails and phone numbers
                  </FieldLabel>
                  <FieldDescription>
                    Masks them as [email] and [phone] before a transcript is saved. It only affects
                    new messages; stored transcripts are not rewritten.
                  </FieldDescription>
                </div>
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={isSubmitting || !isDirty}>
              {isSubmitting ? "Saving..." : "Save settings"}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
}

"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { TagsInput } from "@/components/crm/tags-input";
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
import { mediaExternalCreateSchema, mediaUpdateSchema } from "@/lib/media-schemas";
import { formatBytes } from "@/server/media/types";
import type { MediaView } from "@/server/services/media";

const DESCRIPTION_HINT =
  "The model reads this description to decide when to show the item, so say what it shows and when it fits.";

const editSchema = mediaUpdateSchema.required({ name: true, enabled: true });
type EditValues = z.input<typeof editSchema>;

export function MediaEditDialog({
  item,
  tagSuggestions,
  onOpenChange,
}: {
  /** The item being edited; the dialog is open while this is set. */
  item: MediaView | undefined;
  tagSuggestions: string[];
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: "", description: "", tags: [], enabled: true },
  });

  useEffect(() => {
    if (item) {
      reset({
        name: item.name,
        description: item.description,
        tags: item.tags,
        enabled: item.enabled,
      });
    }
  }, [item, reset]);

  async function onSubmit(values: EditValues) {
    if (!item) return;
    try {
      await adminFetch(`media/${item.id}`, { method: "PATCH", body: values });
      toast.success("Media updated");
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={item !== undefined} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words">Edit media</DialogTitle>
          <DialogDescription className="break-all">
            {item && (
              <>
                <code className="text-xs">{item.id}</code> · {item.mime_type}
                {item.size_bytes !== null && ` · ${formatBytes(item.size_bytes)}`}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="media-name">Name</FieldLabel>
              <Input id="media-name" {...register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.description}>
              <FieldLabel htmlFor="media-description">Description</FieldLabel>
              <Textarea id="media-description" rows={4} {...register("description")} />
              <FieldDescription>{DESCRIPTION_HINT}</FieldDescription>
              <FieldError errors={[errors.description]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="media-tags">Tags</FieldLabel>
              <Controller
                control={control}
                name="tags"
                render={({ field }) => (
                  <TagsInput
                    id="media-tags"
                    value={field.value ?? []}
                    onChange={field.onChange}
                    suggestions={tagSuggestions}
                  />
                )}
              />
              <FieldDescription>
                Agents are allowed media by tag. Press Enter or comma to add one.
              </FieldDescription>
              <FieldError errors={[errors.tags]} />
            </Field>
            <Controller
              control={control}
              name="enabled"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Switch
                    id="media-enabled"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="media-enabled">Enabled</FieldLabel>
                    <FieldDescription>Disabled items are hidden from the client API.</FieldDescription>
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
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const externalFormSchema = mediaExternalCreateSchema;
type ExternalValues = z.input<typeof externalFormSchema>;
const emptyExternal: ExternalValues = {
  name: "",
  description: "",
  tags: [],
  enabled: true,
  external_url: "",
};

export function MediaExternalDialog({
  open,
  onOpenChange,
  tagSuggestions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tagSuggestions: string[];
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | undefined>();
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ExternalValues>({
    resolver: zodResolver(externalFormSchema),
    defaultValues: emptyExternal,
  });

  useEffect(() => {
    if (open) {
      reset(emptyExternal);
      setServerError(undefined);
    }
  }, [open, reset]);

  async function onSubmit(values: ExternalValues) {
    setServerError(undefined);
    try {
      await adminFetch("media", { method: "POST", body: values });
      toast.success("External media added");
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      setServerError(errorMessage(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add external URL</DialogTitle>
          <DialogDescription>
            Link an image or video hosted elsewhere. The gateway checks the URL, its content type
            and its size now, but does not copy the file.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <FieldGroup>
            <Field data-invalid={!!errors.external_url || !!serverError}>
              <FieldLabel htmlFor="external-url">URL</FieldLabel>
              <Input
                id="external-url"
                inputMode="url"
                placeholder="https://example.com/clip.mp4"
                {...register("external_url")}
              />
              <FieldDescription>
                Direct link to a PNG, JPEG, GIF, WebP, MP4 or WebM file (http or https).
              </FieldDescription>
              <FieldError errors={[errors.external_url]} />
              {serverError && (
                <p role="alert" className="break-words text-sm text-destructive">
                  {serverError}
                </p>
              )}
            </Field>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="external-name">Name</FieldLabel>
              <Input id="external-name" {...register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.description}>
              <FieldLabel htmlFor="external-description">Description</FieldLabel>
              <Textarea id="external-description" rows={3} {...register("description")} />
              <FieldDescription>{DESCRIPTION_HINT}</FieldDescription>
              <FieldError errors={[errors.description]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="external-tags">Tags</FieldLabel>
              <Controller
                control={control}
                name="tags"
                render={({ field }) => (
                  <TagsInput
                    id="external-tags"
                    value={field.value ?? []}
                    onChange={field.onChange}
                    suggestions={tagSuggestions}
                  />
                )}
              />
              <FieldError errors={[errors.tags]} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Checking URL..." : "Add media"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

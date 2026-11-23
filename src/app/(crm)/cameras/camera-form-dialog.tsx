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
import { CAMERA_TYPES, httpUrlSchema } from "@/lib/media-schemas";
import type { CameraView } from "@/server/services/cameras";

const formSchema = z
  .object({
    type: z.enum(CAMERA_TYPES),
    name: z.string().trim().min(1, "Enter a name").max(120),
    description: z.string().trim().max(1000),
    enabled: z.boolean(),
    url: z.string(),
    username: z.string(),
    password: z.string(),
    clear_credentials: z.boolean(),
  })
  .superRefine((values, context) => {
    if (values.type !== "mjpeg_url") return;
    const url = httpUrlSchema.safeParse(values.url);
    if (!url.success) {
      context.addIssue({ code: "custom", path: ["url"], message: url.error.issues[0].message });
    }
    if (Boolean(values.username) !== Boolean(values.password)) {
      context.addIssue({
        code: "custom",
        path: [values.username ? "password" : "username"],
        message: "Enter both a username and a password, or neither",
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;

const emptyValues: FormValues = {
  type: "mjpeg_url",
  name: "",
  description: "",
  enabled: true,
  url: "",
  username: "",
  password: "",
  clear_credentials: false,
};

const typeLabels: Record<(typeof CAMERA_TYPES)[number], string> = {
  lookat_sidecar: "Look-at sidecar",
  mjpeg_url: "MJPEG URL",
};

export function CameraFormDialog({
  open,
  camera,
  onOpenChange,
}: {
  open: boolean;
  camera?: CameraView;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: emptyValues });
  const type = watch("type");

  useEffect(() => {
    if (!open) return;
    const known = CAMERA_TYPES.find((entry) => entry === camera?.type);
    reset(
      camera
        ? {
            ...emptyValues,
            type: known ?? "mjpeg_url",
            name: camera.name,
            description: camera.description,
            enabled: camera.enabled,
            url: camera.url ?? "",
          }
        : emptyValues,
    );
  }, [open, camera, reset]);

  async function onSubmit(values: FormValues) {
    const payload: Record<string, unknown> = {
      type: values.type,
      name: values.name,
      description: values.description,
      enabled: values.enabled,
    };
    if (values.type === "mjpeg_url") {
      payload.url = values.url;
      // Credentials are write-only: absent keeps the stored pair, null clears it.
      if (values.username && values.password) {
        payload.credentials = { username: values.username, password: values.password };
      } else if (values.clear_credentials) {
        payload.credentials = null;
      }
    }
    try {
      await adminFetch(camera ? `cameras/${camera.id}` : "cameras", {
        method: camera ? "PATCH" : "POST",
        body: payload,
      });
      toast.success(camera ? "Camera updated" : "Camera created");
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words">
            {camera ? `Edit ${camera.name}` : "New camera"}
          </DialogTitle>
          <DialogDescription>
            Unity connects to cameras directly. Credentials are encrypted at rest and never shown
            again.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="camera-type">Type</FieldLabel>
              <Controller
                control={control}
                name="type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="camera-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CAMERA_TYPES.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                          {typeLabels[entry]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldDescription>
                {type === "lookat_sidecar"
                  ? "The look-at provider video feed already configured in the Unity app. It needs no address here."
                  : "A motion-JPEG stream (multipart/x-mixed-replace) the Unity app opens directly."}
              </FieldDescription>
            </Field>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="camera-name">Name</FieldLabel>
              <Input id="camera-name" {...register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.description}>
              <FieldLabel htmlFor="camera-description">Description</FieldLabel>
              <Textarea id="camera-description" rows={3} {...register("description")} />
              <FieldDescription>
                The model reads this to decide which camera to show.
              </FieldDescription>
              <FieldError errors={[errors.description]} />
            </Field>
            {type === "mjpeg_url" && (
              <>
                <Field data-invalid={!!errors.url}>
                  <FieldLabel htmlFor="camera-url">Stream URL</FieldLabel>
                  <Input
                    id="camera-url"
                    inputMode="url"
                    placeholder="http://192.168.1.20/stream.mjpg"
                    {...register("url")}
                  />
                  <FieldError errors={[errors.url]} />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field data-invalid={!!errors.username}>
                    <FieldLabel htmlFor="camera-username">Username</FieldLabel>
                    <Input
                      id="camera-username"
                      autoComplete="off"
                      placeholder={
                        camera?.credentials
                          ? `Stored: ${camera.credentials.username_masked}`
                          : "Optional"
                      }
                      {...register("username")}
                    />
                    <FieldError errors={[errors.username]} />
                  </Field>
                  <Field data-invalid={!!errors.password}>
                    <FieldLabel htmlFor="camera-password">Password</FieldLabel>
                    <Input
                      id="camera-password"
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        camera?.credentials ? "Stored (leave blank to keep)" : "Optional"
                      }
                      {...register("password")}
                    />
                    <FieldError errors={[errors.password]} />
                  </Field>
                </div>
                {camera?.credentials && (
                  <Controller
                    control={control}
                    name="clear_credentials"
                    render={({ field }) => (
                      <label className="flex items-center gap-2 text-sm">
                        <Switch size="sm" checked={field.value} onCheckedChange={field.onChange} />
                        Remove the stored credentials
                      </label>
                    )}
                  />
                )}
              </>
            )}
            <Controller
              control={control}
              name="enabled"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Switch
                    id="camera-enabled"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="camera-enabled">Enabled</FieldLabel>
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
              {camera ? "Save changes" : "Create camera"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

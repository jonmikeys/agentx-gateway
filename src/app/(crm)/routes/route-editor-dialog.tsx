"use client";

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowDown, ArrowUp, GripVertical, ListRestart, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { adminFetch, errorMessage } from "@/lib/admin-client";
import { routeWriteSchema } from "@/lib/gateway-schemas";
import type { ProviderTestResult } from "@/server/gateway/provider-test";
import type { ProviderView } from "@/server/services/providers";
import type { RouteView } from "@/server/services/routes";

const formSchema = z.object({
  slug: routeWriteSchema.shape.slug,
  description: z.string().max(500),
  enabled: z.boolean(),
  steps: z
    .array(
      z.object({
        provider_id: z.string().min(1, "Choose a provider"),
        upstream_model: z.string().trim().min(1, "Upstream model is required"),
        timeout_ms: z
          .string()
          .regex(/^\d+$/, "Enter milliseconds")
          .refine((value) => Number(value) >= 1000, "At least 1000 ms"),
      }),
    )
    .min(1, "Add at least one step"),
});

type FormValues = z.infer<typeof formSchema>;

const newStep = (): FormValues["steps"][number] => ({
  provider_id: "",
  upstream_model: "",
  timeout_ms: "30000",
});

function SortableStep({
  id,
  index,
  count,
  providers,
  models,
  onLoadModels,
  onMove,
  onRemove,
  register,
  control,
  errors,
}: {
  id: string;
  index: number;
  count: number;
  providers: ProviderView[];
  models: string[];
  onLoadModels: (providerId: string) => void;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
  register: ReturnType<typeof useForm<FormValues>>["register"];
  control: ReturnType<typeof useForm<FormValues>>["control"];
  errors: ReturnType<typeof useForm<FormValues>>["formState"]["errors"];
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const stepErrors = errors.steps?.[index];

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex gap-2 rounded-lg border bg-card p-3 ${isDragging ? "z-10 shadow-md" : ""}`}
    >
      <div className="flex flex-col items-center gap-1 pt-1">
        <button
          type="button"
          className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted"
          aria-label={`Drag step ${index + 1}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <span className="text-xs font-medium text-muted-foreground">{index + 1}</span>
      </div>
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem]">
        <Field data-invalid={!!stepErrors?.provider_id}>
          <FieldLabel>Provider</FieldLabel>
          <Controller
            control={control}
            name={`steps.${index}.provider_id`}
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(value) => {
                  field.onChange(value);
                  onLoadModels(value);
                }}
              >
                <SelectTrigger className="w-full" aria-label={`Step ${index + 1} provider`}>
                  <SelectValue placeholder="Choose provider" />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <FieldError errors={[stepErrors?.provider_id]} />
        </Field>
        <Field data-invalid={!!stepErrors?.upstream_model}>
          <FieldLabel htmlFor={`step-model-${id}`}>Upstream model</FieldLabel>
          <Input
            id={`step-model-${id}`}
            list={`step-models-${id}`}
            placeholder="gpt-4o-mini"
            {...register(`steps.${index}.upstream_model`)}
          />
          <datalist id={`step-models-${id}`}>
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <FieldError errors={[stepErrors?.upstream_model]} />
        </Field>
        <Field data-invalid={!!stepErrors?.timeout_ms}>
          <FieldLabel htmlFor={`step-timeout-${id}`}>Timeout (ms)</FieldLabel>
          <Input
            id={`step-timeout-${id}`}
            inputMode="numeric"
            {...register(`steps.${index}.timeout_ms`)}
          />
          <FieldError errors={[stepErrors?.timeout_ms]} />
        </Field>
      </div>
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Move step ${index + 1} up`}
          disabled={index === 0}
          onClick={() => onMove(index, index - 1)}
        >
          <ArrowUp />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Move step ${index + 1} down`}
          disabled={index === count - 1}
          onClick={() => onMove(index, index + 1)}
        >
          <ArrowDown />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove step ${index + 1}`}
          disabled={count === 1}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

export function RouteEditorDialog({
  open,
  route,
  providers,
  onOpenChange,
}: {
  open: boolean;
  /** The route being edited, or undefined to create one. */
  route?: RouteView;
  providers: ProviderView[];
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const requestedProviders = useRef(new Set<string>());
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { slug: "", description: "", enabled: true, steps: [newStep()] },
  });
  const { fields, append, remove, move } = useFieldArray({ control, name: "steps" });
  const watchedSteps = useWatch({ control, name: "steps" });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const loadModels = useCallback(async (providerId: string) => {
    if (!providerId || requestedProviders.current.has(providerId)) return;
    requestedProviders.current.add(providerId);
    try {
      const result = await adminFetch<ProviderTestResult>(`providers/${providerId}/test`, {
        method: "POST",
      });
      if (result.ok)
        setModelsByProvider((current) => ({ ...current, [providerId]: result.models }));
    } catch {
      // Suggestions are optional; the field accepts any model name.
      requestedProviders.current.delete(providerId);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    reset(
      route
        ? {
            slug: route.slug,
            description: route.description,
            enabled: route.enabled,
            steps: route.steps.map((step) => ({
              provider_id: step.provider_id,
              upstream_model: step.upstream_model,
              timeout_ms: String(step.timeout_ms),
            })),
          }
        : { slug: "", description: "", enabled: true, steps: [newStep()] },
    );
    for (const step of route?.steps ?? []) void loadModels(step.provider_id);
  }, [open, route, reset, loadModels]);

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = fields.findIndex((field) => field.id === active.id);
    const to = fields.findIndex((field) => field.id === over.id);
    move(
      from,
      arrayMove(fields, from, to).findIndex((field) => field.id === active.id),
    );
  }

  async function onSubmit(values: FormValues) {
    const payload = {
      slug: values.slug,
      description: values.description,
      enabled: values.enabled,
      steps: values.steps.map((step) => ({
        provider_id: step.provider_id,
        upstream_model: step.upstream_model,
        timeout_ms: Number(step.timeout_ms),
      })),
    };
    try {
      await adminFetch(route ? `routes/${route.id}` : "routes", {
        method: route ? "PUT" : "POST",
        body: payload,
      });
      toast.success(route ? "Route updated" : "Route created");
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{route ? `Edit ${route.slug}` : "New model route"}</DialogTitle>
          <DialogDescription>
            Clients send the slug as <code>model</code>. Steps are tried in order; the next step is
            used when the previous one fails over.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.slug}>
                <FieldLabel htmlFor="route-slug">Slug</FieldLabel>
                <Input id="route-slug" placeholder="avatar-default" {...register("slug")} />
                <FieldError errors={[errors.slug]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="route-description">Description</FieldLabel>
                <Input id="route-description" {...register("description")} />
              </Field>
            </div>
            <Controller
              control={control}
              name="enabled"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Switch
                    id="route-enabled"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                  <FieldLabel htmlFor="route-enabled">Enabled</FieldLabel>
                </Field>
              )}
            />
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Steps</h3>
                <Button type="button" variant="outline" size="sm" onClick={() => append(newStep())}>
                  <Plus />
                  Add step
                </Button>
              </div>
              <FieldDescription>
                Drag the handle to reorder, or use the arrow buttons. Model suggestions load from
                the provider's /models endpoint when you pick it.
              </FieldDescription>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={fields.map((field) => field.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <ol className="flex flex-col gap-2">
                    {fields.map((field, index) => (
                      <SortableStep
                        key={field.id}
                        id={field.id}
                        index={index}
                        count={fields.length}
                        providers={providers}
                        models={modelsByProvider[watchedSteps?.[index]?.provider_id ?? ""] ?? []}
                        onLoadModels={loadModels}
                        onMove={move}
                        onRemove={() => remove(index)}
                        register={register}
                        control={control}
                        errors={errors}
                      />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
              {errors.steps?.root && <FieldError errors={[errors.steps.root]} />}
              {errors.steps?.message && <FieldError>{errors.steps.message}</FieldError>}
            </div>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              <ListRestart />
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {route ? "Save route" : "Create route"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

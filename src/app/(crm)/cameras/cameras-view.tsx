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
import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CircleX,
  Eye,
  GripVertical,
  Pencil,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CameraFormDialog } from "@/app/(crm)/cameras/camera-form-dialog";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminFetch, errorMessage } from "@/lib/admin-client";
import type { MjpegTestResult } from "@/server/media/mjpeg";
import type { CameraView } from "@/server/services/cameras";

interface RowActions {
  onMove: (from: number, to: number) => void;
  onToggle: (camera: CameraView, enabled: boolean) => void;
  onTest: (camera: CameraView) => void;
  onPreview: (camera: CameraView) => void;
  onEdit: (camera: CameraView) => void;
  onDelete: (camera: CameraView) => void;
  testing?: string;
}

function CameraRow({
  camera,
  index,
  count,
  actions,
}: {
  camera: CameraView;
  index: number;
  count: number;
  actions: RowActions;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: camera.id,
  });
  return (
    <TableRow
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "relative z-10 bg-card shadow-md" : undefined}
    >
      <TableCell className="w-px whitespace-nowrap">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="cursor-grab touch-none rounded p-1 text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label={`Drag ${camera.name}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" />
          </button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Move ${camera.name} up`}
            disabled={index === 0}
            onClick={() => actions.onMove(index, index - 1)}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Move ${camera.name} down`}
            disabled={index === count - 1}
            onClick={() => actions.onMove(index, index + 1)}
          >
            <ArrowDown />
          </Button>
        </div>
      </TableCell>
      <TableCell className="max-w-[16rem] min-w-32">
        <div className="truncate font-medium" title={camera.name}>
          {camera.name}
        </div>
        {camera.description && (
          <div className="truncate text-xs text-muted-foreground" title={camera.description}>
            {camera.description}
          </div>
        )}
      </TableCell>
      <TableCell>
        <Badge variant="outline">{camera.type}</Badge>
      </TableCell>
      <TableCell className="max-w-[18rem] min-w-32">
        {camera.url ? (
          <div className="truncate font-mono text-xs text-muted-foreground" title={camera.url}>
            {camera.url}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">No address (configured in Unity)</span>
        )}
      </TableCell>
      <TableCell>
        <Switch
          aria-label={`Enable ${camera.name}`}
          checked={camera.enabled}
          onCheckedChange={(checked) => actions.onToggle(camera, checked)}
        />
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          {camera.previewable && (
            <Button
              variant="outline"
              size="sm"
              disabled={actions.testing === camera.id}
              aria-label={`Test ${camera.name}`}
              onClick={() => actions.onTest(camera)}
            >
              <Zap />
              {actions.testing === camera.id ? "Testing..." : "Test"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Preview ${camera.name}`}
            onClick={() => actions.onPreview(camera)}
          >
            <Eye />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Edit ${camera.name}`}
            onClick={() => actions.onEdit(camera)}
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete ${camera.name}`}
            onClick={() => actions.onDelete(camera)}
          >
            <Trash2 />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function PreviewBody({ camera }: { camera: CameraView }) {
  const [failed, setFailed] = useState(false);
  if (!camera.previewable) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        Preview is not available for {camera.type} cameras: the feed is shown by the Unity app from
        its own look-at provider.
      </p>
    );
  }
  if (failed) {
    return (
      <p
        role="alert"
        className="rounded-lg border border-dashed p-6 text-center text-sm text-destructive"
      >
        Could not load the stream. Check that the camera is reachable from the gateway and serves
        MJPEG (try Test).
      </p>
    );
  }
  return (
    <img
      src={`/api/admin/cameras/${camera.id}/preview`}
      alt={`Live preview of ${camera.name}`}
      className="max-h-[60svh] w-full rounded-lg bg-muted object-contain"
      onError={() => setFailed(true)}
    />
  );
}

export function CamerasView({ cameras }: { cameras: CameraView[] }) {
  const router = useRouter();
  const [items, setItems] = useState(cameras);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CameraView | undefined>();
  const [deleting, setDeleting] = useState<CameraView | undefined>();
  const [previewing, setPreviewing] = useState<CameraView | undefined>();
  const [testing, setTesting] = useState<string | undefined>();
  const [testResult, setTestResult] = useState<
    { camera: CameraView; result: MjpegTestResult } | undefined
  >();
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => setItems(cameras), [cameras]);

  async function move(from: number, to: number) {
    const next = arrayMove(items, from, to);
    setItems(next);
    try {
      await adminFetch("cameras/reorder", {
        method: "POST",
        body: { ids: next.map((camera) => camera.id) },
      });
      router.refresh();
    } catch (error) {
      setItems(cameras);
      toast.error(errorMessage(error));
    }
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    move(
      items.findIndex((camera) => camera.id === active.id),
      items.findIndex((camera) => camera.id === over.id),
    );
  }

  async function toggle(camera: CameraView, enabled: boolean) {
    try {
      await adminFetch(`cameras/${camera.id}`, { method: "PATCH", body: { enabled } });
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function runTest(camera: CameraView) {
    setTesting(camera.id);
    try {
      const result = await adminFetch<MjpegTestResult>(`cameras/${camera.id}/test`, {
        method: "POST",
      });
      setTestResult({ camera, result });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTesting(undefined);
    }
  }

  async function confirmDelete(camera: CameraView) {
    try {
      await adminFetch(`cameras/${camera.id}`, { method: "DELETE" });
      toast.success(`Deleted ${camera.name}`);
      setDeleting(undefined);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const actions: RowActions = {
    onMove: move,
    onToggle: toggle,
    onTest: runTest,
    onPreview: setPreviewing,
    onEdit: (camera) => {
      setEditing(camera);
      setFormOpen(true);
    },
    onDelete: setDeleting,
    testing,
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Cameras"
        description="Camera streams the avatar may show. Unity connects to them directly."
        action={
          <Button
            onClick={() => {
              setEditing(undefined);
              setFormOpen(true);
            }}
          >
            <Plus />
            New camera
          </Button>
        }
      />
      <div className="rounded-lg border [contain:inline-size]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <span className="sr-only">Order</span>
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No cameras yet. Add the look-at feed or an MJPEG stream the avatar can show.
                </TableCell>
              </TableRow>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={items.map((camera) => camera.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {items.map((camera, index) => (
                    <CameraRow
                      key={camera.id}
                      camera={camera}
                      index={index}
                      count={items.length}
                      actions={actions}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </TableBody>
        </Table>
      </div>

      <CameraFormDialog open={formOpen} camera={editing} onOpenChange={setFormOpen} />

      <Dialog open={previewing !== undefined} onOpenChange={() => setPreviewing(undefined)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="break-words">{previewing?.name}</DialogTitle>
            <DialogDescription>
              Live preview through the gateway (admin only). Unity connects to the camera directly.
            </DialogDescription>
          </DialogHeader>
          {previewing && <PreviewBody camera={previewing} />}
        </DialogContent>
      </Dialog>

      <Dialog open={testResult !== undefined} onOpenChange={() => setTestResult(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {testResult?.result.ok ? (
                <CircleCheck className="size-5 text-primary" />
              ) : (
                <CircleX className="size-5 text-destructive" />
              )}
              Camera test {testResult?.result.ok ? "passed" : "failed"}
            </DialogTitle>
            <DialogDescription className="break-words">{testResult?.camera.name}</DialogDescription>
          </DialogHeader>
          {testResult && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Latency</dt>
              <dd>{testResult.result.latency_ms} ms</dd>
              <dt className="text-muted-foreground">Content type</dt>
              <dd className="break-all font-mono text-xs">
                {testResult.result.content_type ?? "none"}
              </dd>
              {testResult.result.error && (
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
            <AlertDialogTitle className="break-words">Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the camera and its stored credentials. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {deleting && (
              <AlertDialogAction variant="destructive" onClick={() => confirmDelete(deleting)}>
                Delete
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

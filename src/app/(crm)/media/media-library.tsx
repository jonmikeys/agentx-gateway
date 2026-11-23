"use client";

import { ImageIcon, Link2, Search, Upload } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { MediaCard } from "@/app/(crm)/media/media-card";
import { MediaEditDialog, MediaExternalDialog } from "@/app/(crm)/media/media-form-dialogs";
import { MediaUploadDialog } from "@/app/(crm)/media/media-upload-dialog";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { adminFetch, errorMessage } from "@/lib/admin-client";
import type { MediaView } from "@/server/services/media";

export function MediaLibrary({ items, tags }: { items: MediaView[]; tags: string[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [tag, setTag] = useState("all");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [externalOpen, setExternalOpen] = useState(false);
  const [editing, setEditing] = useState<MediaView | undefined>();
  const [deleting, setDeleting] = useState<MediaView | undefined>();
  const [previewing, setPreviewing] = useState<MediaView | undefined>();

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter(
      (item) =>
        (kind === "all" || item.kind === kind) &&
        (tag === "all" || item.tags.includes(tag)) &&
        (!needle ||
          item.name.toLowerCase().includes(needle) ||
          item.description.toLowerCase().includes(needle)),
    );
  }, [items, search, kind, tag]);

  const filtered = search.trim() !== "" || kind !== "all" || tag !== "all";

  async function toggleEnabled(item: MediaView, enabled: boolean) {
    try {
      await adminFetch(`media/${item.id}`, { method: "PATCH", body: { enabled } });
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function confirmDelete(item: MediaView) {
    try {
      await adminFetch(`media/${item.id}`, { method: "DELETE" });
      toast.success(`Deleted ${item.name}`);
      setDeleting(undefined);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Media"
        description="Images and videos the avatar may show. Uploads are stored by the gateway; external URLs are linked."
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setExternalOpen(true)}>
              <Link2 />
              Add external URL
            </Button>
            <Button onClick={() => setUploadOpen(true)}>
              <Upload />
              Upload media
            </Button>
          </div>
        }
      />

      {items.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-0 flex-1 basis-56">
            <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Search media"
              placeholder="Search name or description"
              className="pl-8"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger aria-label="Filter by kind" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              <SelectItem value="image">Images</SelectItem>
              <SelectItem value="video">Videos</SelectItem>
            </SelectContent>
          </Select>
          <Select value={tag} onValueChange={setTag}>
            <SelectTrigger aria-label="Filter by tag" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tags</SelectItem>
              {tags.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {entry}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
          <ImageIcon className="size-8 text-muted-foreground" />
          <div>
            <p className="font-medium">No media yet</p>
            <p className="text-sm text-muted-foreground">
              Upload an image or video, or link one by URL. The avatar can then show it on request.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => setUploadOpen(true)}>
              <Upload />
              Upload media
            </Button>
            <Button variant="outline" onClick={() => setExternalOpen(true)}>
              <Link2 />
              Add external URL
            </Button>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          No media matches these filters.
          {filtered && (
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setKind("all");
                  setTag("all");
                }}
              >
                Clear filters
              </Button>
            </div>
          )}
        </div>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-4">
          {visible.map((item) => (
            <MediaCard
              key={item.id}
              item={item}
              onPreview={setPreviewing}
              onEdit={setEditing}
              onDelete={setDeleting}
              onToggleEnabled={toggleEnabled}
            />
          ))}
        </ul>
      )}

      <MediaUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} tagSuggestions={tags} />
      <MediaExternalDialog
        open={externalOpen}
        onOpenChange={setExternalOpen}
        tagSuggestions={tags}
      />
      <MediaEditDialog
        item={editing}
        tagSuggestions={tags}
        onOpenChange={(open) => !open && setEditing(undefined)}
      />

      <Dialog open={previewing !== undefined} onOpenChange={() => setPreviewing(undefined)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="break-words">{previewing?.name}</DialogTitle>
            <DialogDescription className="break-words">
              {previewing?.description || "No description."}
            </DialogDescription>
          </DialogHeader>
          {previewing &&
            (previewing.kind === "image" ? (
              <Image
                unoptimized
                width={1280}
                height={720}
                src={previewing.preview_url}
                alt={previewing.name}
                className="h-auto max-h-[70svh] w-full rounded-lg object-contain"
              />
            ) : (
              <video
                src={previewing.preview_url}
                controls
                className="max-h-[70svh] w-full rounded-lg"
              >
                <track kind="captions" />
              </video>
            ))}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== undefined} onOpenChange={() => setDeleting(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.source === "upload"
                ? "This removes the item and its stored file. It cannot be undone."
                : "This removes the item. The external file is not touched."}
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

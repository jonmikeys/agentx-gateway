"use client";

import { Film, ImageIcon, Pencil, Play, Trash2 } from "lucide-react";
import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/server/media/types";
import type { MediaView } from "@/server/services/media";

/** Thumbnail: the image itself, or the first frame of a video (`preload="metadata"`). */
export function MediaThumbnail({ item, className }: { item: MediaView; className?: string }) {
  if (item.kind === "image") {
    return (
      <Image
        unoptimized
        width={320}
        height={180}
        src={item.preview_url}
        alt=""
        loading="lazy"
        className={className ?? "size-full object-cover"}
      />
    );
  }
  return (
    <video
      src={`${item.preview_url}#t=0.1`}
      preload="metadata"
      muted
      playsInline
      aria-hidden="true"
      tabIndex={-1}
      className={className ?? "size-full object-cover"}
    />
  );
}

function describeFile(item: MediaView): string {
  const parts: string[] = [];
  if (item.width && item.height) parts.push(`${item.width}x${item.height}`);
  if (item.size_bytes !== null) parts.push(formatBytes(item.size_bytes));
  parts.push(item.source === "external_url" ? "External" : "Uploaded");
  return parts.join(" · ");
}

export function MediaCard({
  item,
  onPreview,
  onEdit,
  onDelete,
  onToggleEnabled,
}: {
  item: MediaView;
  onPreview: (item: MediaView) => void;
  onEdit: (item: MediaView) => void;
  onDelete: (item: MediaView) => void;
  onToggleEnabled: (item: MediaView, enabled: boolean) => void;
}) {
  const KindIcon = item.kind === "image" ? ImageIcon : Film;
  return (
    <li
      className="flex min-w-0 flex-col overflow-hidden rounded-xl bg-card text-sm text-card-foreground ring-1 ring-foreground/10"
      data-testid="media-card"
    >
      <button
        type="button"
        onClick={() => onPreview(item)}
        aria-label={`Preview ${item.name}`}
        className="group/thumb relative block aspect-video w-full overflow-hidden bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className={item.enabled ? "block size-full" : "block size-full opacity-50"}>
          <MediaThumbnail item={item} />
        </span>
        {item.kind === "video" && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm ring-1 ring-foreground/10">
              <Play className="size-4" />
            </span>
          </span>
        )}
        {!item.enabled && (
          <Badge variant="outline" className="absolute top-2 left-2 bg-background/90">
            Disabled
          </Badge>
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h2 className="min-w-0 truncate text-sm font-medium" title={item.name}>
            {item.name}
          </h2>
          <Badge variant="secondary" className="shrink-0">
            <KindIcon />
            {item.kind}
          </Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground" title={describeFile(item)}>
          {describeFile(item)}
        </p>
        <div className="flex min-h-5 min-w-0 flex-wrap gap-1">
          {item.tags.length === 0 ? (
            <span className="text-xs text-muted-foreground">No tags</span>
          ) : (
            item.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="max-w-full">
                <span className="truncate" title={tag}>
                  {tag}
                </span>
              </Badge>
            ))
          )}
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              size="sm"
              id={`media-enabled-${item.id}`}
              aria-label={`Enable ${item.name}`}
              checked={item.enabled}
              onCheckedChange={(checked) => onToggleEnabled(item, checked)}
            />
            <Label htmlFor={`media-enabled-${item.id}`} className="text-xs font-normal">
              {item.enabled ? "Enabled" : "Disabled"}
            </Label>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${item.name}`}
              onClick={() => onEdit(item)}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${item.name}`}
              onClick={() => onDelete(item)}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}

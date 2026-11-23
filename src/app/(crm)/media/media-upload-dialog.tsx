"use client";

import { CircleAlert, CircleCheck, FileUp, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { allowedMediaTypes, formatBytes } from "@/server/media/types";

type UploadState = "ready" | "uploading" | "done" | "error";

interface QueuedFile {
  key: string;
  file: File;
  state: UploadState;
  progress: number;
  error?: string;
}

const acceptedTypes = Object.keys(allowedMediaTypes).join(",");

/** Early, advisory check from the browser's idea of the type; the server checks the bytes. */
function validateFile(file: File): string | undefined {
  const type = allowedMediaTypes[file.type];
  if (!type) return "Not a PNG, JPEG, GIF, WebP, MP4 or WebM file";
  if (file.size > type.maxBytes) {
    return `Too large: ${formatBytes(file.size)} (${type.kind}s up to ${formatBytes(type.maxBytes)})`;
  }
  if (file.size === 0) return "The file is empty";
  return undefined;
}

function uploadOne(
  file: File,
  tags: string[],
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    // Fields must come before the file part: the server streams the file straight to disk.
    form.append("name", file.name.replace(/\.[^.]+$/, ""));
    form.append("tags", JSON.stringify(tags));
    form.append("file", file);
    const request = new XMLHttpRequest();
    request.open("POST", "/api/admin/media/upload");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      let message = `Upload failed (HTTP ${request.status})`;
      try {
        message = JSON.parse(request.responseText).error?.message ?? message;
      } catch {
        // Keep the generic message.
      }
      reject(new Error(message));
    };
    request.onerror = () => reject(new Error("Network error during upload"));
    request.send(form);
  });
}

export function MediaUploadDialog({
  open,
  onOpenChange,
  tagSuggestions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tagSuggestions: string[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setFiles([]);
      setTags([]);
      setBusy(false);
    }
  }, [open]);

  function addFiles(list: FileList | File[]) {
    const added = Array.from(list).map((file, index) => {
      const error = validateFile(file);
      return {
        key: `${file.name}-${file.size}-${Date.now()}-${index}`,
        file,
        state: error ? "error" : "ready",
        progress: 0,
        error,
      } satisfies QueuedFile;
    });
    setFiles((current) => [...current, ...added]);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    if (!busy) addFiles(event.dataTransfer.files);
  }

  function patch(key: string, changes: Partial<QueuedFile>) {
    setFiles((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...changes } : entry)),
    );
  }

  async function startUpload() {
    setBusy(true);
    let succeeded = 0;
    for (const entry of files.filter((candidate) => candidate.state === "ready")) {
      patch(entry.key, { state: "uploading", progress: 0 });
      try {
        await uploadOne(entry.file, tags, (progress) => patch(entry.key, { progress }));
        patch(entry.key, { state: "done", progress: 1 });
        succeeded += 1;
      } catch (error) {
        patch(entry.key, {
          state: "error",
          error: error instanceof Error ? error.message : "Upload failed",
        });
      }
    }
    setBusy(false);
    router.refresh();
    if (succeeded > 0) toast.success(`Uploaded ${succeeded} ${succeeded === 1 ? "file" : "files"}`);
  }

  const readyCount = files.filter((entry) => entry.state === "ready").length;
  const allDone = files.length > 0 && files.every((entry) => entry.state !== "ready");

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload media</DialogTitle>
          <DialogDescription>
            Images up to 20 MB (PNG, JPEG, GIF, WebP) and videos up to 200 MB (MP4, WebM). The type
            is checked from the file contents.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-sm outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 ${dragging ? "border-primary bg-muted" : "border-input"}`}
          >
            <FileUp className="size-6 text-muted-foreground" />
            <span className="font-medium">Drop files here or click to choose</span>
            <span className="text-xs text-muted-foreground">
              PNG, JPEG, GIF, WebP, MP4 or WebM
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={acceptedTypes}
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose files to upload"
            data-testid="media-file-input"
            onChange={(event) => {
              if (event.target.files) addFiles(event.target.files);
              event.target.value = "";
            }}
          />

          {files.length > 0 && (
            <ul className="flex flex-col gap-2" aria-label="Files to upload">
              {files.map((entry) => (
                <li
                  key={entry.key}
                  className="flex min-w-0 flex-col gap-1 rounded-lg border p-2 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {entry.state === "done" && <CircleCheck className="size-4 shrink-0 text-primary" />}
                    {entry.state === "error" && (
                      <CircleAlert className="size-4 shrink-0 text-destructive" />
                    )}
                    <span className="min-w-0 flex-1 truncate" title={entry.file.name}>
                      {entry.file.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatBytes(entry.file.size)}
                    </span>
                    {!busy && entry.state !== "done" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${entry.file.name}`}
                        onClick={() =>
                          setFiles((current) => current.filter((item) => item.key !== entry.key))
                        }
                      >
                        <X />
                      </Button>
                    )}
                  </div>
                  {entry.state === "uploading" && (
                    <div
                      role="progressbar"
                      aria-label={`Uploading ${entry.file.name}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(entry.progress * 100)}
                      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                    >
                      <div
                        className="h-full bg-primary transition-[width]"
                        style={{ width: `${Math.round(entry.progress * 100)}%` }}
                      />
                    </div>
                  )}
                  {entry.state === "error" && (
                    <p className="break-words text-xs text-destructive" role="alert">
                      {entry.error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <Field>
            <FieldLabel htmlFor="upload-tags">Tags for these files</FieldLabel>
            <TagsInput
              id="upload-tags"
              value={tags}
              onChange={setTags}
              suggestions={tagSuggestions}
            />
            <FieldDescription>
              Name each file's purpose in its description afterwards: the model reads it to choose
              what to show.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {allDone ? "Close" : "Cancel"}
          </Button>
          <Button type="button" disabled={busy || readyCount === 0} onClick={startUpload}>
            {busy
              ? "Uploading..."
              : `Upload ${readyCount > 0 ? `${readyCount} ${readyCount === 1 ? "file" : "files"}` : ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

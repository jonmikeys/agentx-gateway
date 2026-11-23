"use client";

import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AdminApiError, adminFetch, errorMessage } from "@/lib/admin-client";
import type { FlowDetail } from "@/lib/agents/types";
import type { ValidationProblem } from "@/lib/agents/validate";

interface PublishDialogProps {
  open: boolean;
  flowId: string;
  onOpenChange: (open: boolean) => void;
  onPublished: (flow: FlowDetail) => void;
}

/** Validates the saved draft, then publishes the next immutable version. */
export function PublishDialog({ open, flowId, onOpenChange, onPublished }: PublishDialogProps) {
  const [problems, setProblems] = useState<ValidationProblem[] | undefined>();
  const [checked, setChecked] = useState(false);
  const [note, setNote] = useState("");
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    if (!open) return;
    setChecked(false);
    setProblems(undefined);
    setNote("");
    let cancelled = false;
    adminFetch<{ valid: boolean; problems: ValidationProblem[] }>(`flows/${flowId}/validate`)
      .then((result) => {
        if (!cancelled) {
          setProblems(result.problems);
          setChecked(true);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) toast.error(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, flowId]);

  async function publish() {
    setPublishing(true);
    try {
      const result = await adminFetch<{ version: number; flow: FlowDetail }>(
        `flows/${flowId}/publish`,
        { method: "POST", body: { note } },
      );
      toast.success(`Published version ${result.version}`);
      onPublished(result.flow);
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
      if (error instanceof AdminApiError && Array.isArray(error.details)) {
        setProblems(error.details as ValidationProblem[]);
      }
    } finally {
      setPublishing(false);
    }
  }

  const valid = checked && problems !== undefined && problems.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish chatflow</DialogTitle>
          <DialogDescription>
            Publishing validates the draft and creates an immutable version. Clients pick up the new
            version on their next request.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!checked ? (
            <p className="text-sm text-muted-foreground">Validating…</p>
          ) : problems && problems.length > 0 ? (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                <CircleAlert className="size-4" />
                {problems.length} problem{problems.length === 1 ? "" : "s"} to fix
              </p>
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2 text-xs">
                {problems.map((problem) => (
                  <li
                    key={`${problem.nodeId ?? "flow"}-${problem.message}`}
                    className="break-words"
                  >
                    {problem.nodeTitle && (
                      <span className="font-medium">{problem.nodeTitle}: </span>
                    )}
                    {problem.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CircleCheck className="size-4 text-muted-foreground" />
              Validation passed.
            </p>
          )}

          <div className="grid gap-2">
            <Label htmlFor="publish-note">Version note</Label>
            <Textarea
              id="publish-note"
              rows={2}
              placeholder="What changed in this version?"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={publish} disabled={!valid || publishing}>
            {publishing ? "Publishing…" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

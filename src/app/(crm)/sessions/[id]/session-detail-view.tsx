"use client";

import { ArrowLeft, Download, FileText, OctagonX, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SessionStatusBadge } from "@/components/sessions/status-badge";
import { Transcript } from "@/components/sessions/transcript";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { adminFetch, errorMessage, formatTimestamp } from "@/lib/admin-client";
import type { SessionDetail } from "@/lib/session-types";

const POLL_INTERVAL_MS = 3000;

function Metadata({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

export function SessionDetailView({ initial }: { initial: SessionDetail }) {
  const router = useRouter();
  const [session, setSession] = useState(initial);
  const [confirming, setConfirming] = useState<"end" | "delete" | undefined>();
  const isLive = session.status === "active";

  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(async () => {
      try {
        setSession(await adminFetch<SessionDetail>(`sessions/${initial.id}`));
      } catch {
        // Keep showing the last good state; the next poll retries.
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [initial.id, isLive]);

  async function endSession() {
    try {
      setSession(await adminFetch<SessionDetail>(`sessions/${session.id}/end`, { method: "POST" }));
      toast.success("Session ended. The next client request gets session_not_found.");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setConfirming(undefined);
    }
  }

  async function deleteSession() {
    try {
      await adminFetch(`sessions/${session.id}`, { method: "DELETE" });
      toast.success("Session deleted");
      router.push("/sessions");
    } catch (error) {
      toast.error(errorMessage(error));
      setConfirming(undefined);
    }
  }

  const exportBase = `/api/admin/sessions/${session.id}/export`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href="/sessions">
              <ArrowLeft />
              All sessions
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Session transcript</h1>
            <SessionStatusBadge status={session.status} />
            {session.standalone && <Badge variant="outline">Standalone</Badge>}
            {isLive && (
              <span
                data-testid="live-indicator"
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
              >
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
                Live
              </span>
            )}
          </div>
          <p className="font-mono text-xs text-muted-foreground">{session.id}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!isLive} onClick={() => setConfirming("end")}>
            <OctagonX />
            End session
          </Button>
          <Button asChild variant="outline">
            <a href={`${exportBase}?format=json`} download>
              <Download />
              Export JSON
            </a>
          </Button>
          <Button asChild variant="outline">
            <a href={`${exportBase}?format=md`} download>
              <FileText />
              Export Markdown
            </a>
          </Button>
          <Button variant="destructive" onClick={() => setConfirming("delete")}>
            <Trash2 />
            Delete
          </Button>
        </div>
      </div>

      <Card>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Metadata label="Client key">{session.api_key_label ?? "Deleted key"}</Metadata>
            <Metadata label="Route">{session.route_slug ?? "n/a"}</Metadata>
            <Metadata label="Agent">{session.agent_id ?? "None (direct model)"}</Metadata>
            <Metadata label="Turns">{session.turn_count}</Metadata>
            <Metadata label="Started">{formatTimestamp(session.started_at)}</Metadata>
            <Metadata label="Last activity">{formatTimestamp(session.last_activity_at)}</Metadata>
            <Metadata label="Ended">
              {session.ended_at ? formatTimestamp(session.ended_at) : "Still active"}
            </Metadata>
            <Metadata label="End reason">{session.end_reason ?? "n/a"}</Metadata>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transcript</CardTitle>
          <CardDescription>
            Only new messages are stored each turn. Thinking blocks are recorded only when the
            provider streams them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Transcript session={session} />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Agent run trace</CardTitle>
            <CardDescription>
              Per-node traces of agent runs appear here once agents ship (stage G7).
            </CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Session memory</CardTitle>
            <CardDescription>
              Variables and memory keys of an agent session appear here once agents ship (stage G7).
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      <AlertDialog
        open={confirming === "end"}
        onOpenChange={(open) => !open && setConfirming(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this session?</AlertDialogTitle>
            <AlertDialogDescription>
              The transcript is kept. The client's next request with this session id receives 404
              session_not_found and starts a new conversation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={endSession}>End session</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirming === "delete"}
        onOpenChange={(open) => !open && setConfirming(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this session?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the session, its transcript and its linked request logs. It
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={deleteSession}>
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

import { Badge } from "@/components/ui/badge";
import type { SessionStatus } from "@/lib/session-types";

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  const variant = status === "active" ? "default" : status === "ended" ? "secondary" : "outline";
  return <Badge variant={variant}>{status}</Badge>;
}

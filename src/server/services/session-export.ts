import { renderSessionMarkdown } from "@/lib/session-markdown";
import type { SessionDetail } from "@/lib/session-types";
import {
  findSessionDetail,
  iterateSessionIds,
  type SessionFilters,
} from "@/server/services/session-queries";

export type ExportFormat = "json" | "md" | "csv";

export const CSV_COLUMNS = [
  "id",
  "client_key",
  "route",
  "agent",
  "status",
  "end_reason",
  "standalone",
  "started_at",
  "last_activity_at",
  "ended_at",
  "turns",
  "requests",
  "total_tokens",
] as const;

/** Quotes a CSV field and neutralises spreadsheet formula prefixes. */
export function csvField(value: string | number | boolean | null): string {
  if (value === null) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function sessionCsvRow(session: SessionDetail): string {
  const requests = session.turns.flatMap((turn) => turn.requests);
  const tokens = requests.reduce((sum, request) => sum + (request.usage?.total_tokens ?? 0), 0);
  return [
    session.id,
    session.api_key_label,
    session.route_slug,
    session.agent_id,
    session.status,
    session.end_reason,
    session.standalone,
    session.started_at,
    session.last_activity_at,
    session.ended_at,
    session.turn_count,
    requests.length,
    tokens,
  ]
    .map(csvField)
    .join(",");
}

export type ExportSelection = { ids: string[] } | { filters: SessionFilters };

/** Streams sessions in batches so large exports never sit in memory. */
export function streamSessionsExport(
  selection: ExportSelection,
  format: "json" | "csv",
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const batches = iterateSessionIds(selection);
  let first = true;
  let started = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const emit = (text: string) => controller.enqueue(encoder.encode(text));
      if (!started) {
        started = true;
        emit(format === "csv" ? `${CSV_COLUMNS.join(",")}\n` : "[");
      }
      const next = await batches.next();
      if (next.done) {
        if (format === "json") emit("]\n");
        controller.close();
        return;
      }
      for (const id of next.value) {
        const detail = await findSessionDetail(id);
        if (!detail) continue;
        if (format === "csv") {
          emit(`${sessionCsvRow(detail)}\n`);
        } else {
          emit(`${first ? "\n" : ",\n"}${JSON.stringify(detail)}`);
          first = false;
        }
      }
    },
    async cancel() {
      await batches.return(undefined);
    },
  });
}

export function sessionMarkdown(detail: SessionDetail): string {
  return renderSessionMarkdown(detail);
}

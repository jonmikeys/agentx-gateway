import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  type SessionFiltersInput,
  sessionBulkDeleteSchema,
  sessionFiltersSchema,
} from "@/lib/gateway-schemas";
import { renderSessionMarkdown } from "@/lib/session-markdown";
import { adminError, handleServiceError, parseBody } from "@/server/api/admin/helpers";
import { streamSessionsExport } from "@/server/services/session-export";
import { runMaintenance } from "@/server/services/session-maintenance";
import {
  deleteSession,
  deleteSessionsBySelection,
  getSessionDetail,
  listSessions,
  SESSION_SORT_KEYS,
} from "@/server/services/session-queries";
import { endSession } from "@/server/services/sessions";

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(SESSION_SORT_KEYS as [string, ...string[]]).default("started_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

const exportQuerySchema = z.object({
  format: z.enum(["csv", "json"]).default("csv"),
  ids: z.string().optional(),
});

type QueryResult<T> = { data: T } | { response: Response };

function parseFilters(c: Context): QueryResult<SessionFiltersInput> {
  const query = c.req.query();
  const result = sessionFiltersSchema.safeParse({
    status: query.status || undefined,
    api_key_id: query.api_key_id || undefined,
    route: query.route || undefined,
    agent: query.agent || undefined,
    from: query.from || undefined,
    to: query.to || undefined,
    include_standalone: query.include_standalone === "true",
    q: query.q || undefined,
  });
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      response: adminError(
        c,
        400,
        "validation_error",
        `${issue?.path.join(".") ?? "query"}: ${issue?.message ?? "invalid"}`,
      ),
    };
  }
  return { data: result.data };
}

function download(body: BodyInit, contentType: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export function createSessionsApp(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const filters = parseFilters(c);
    if ("response" in filters) return filters.response;
    const paging = paginationSchema.safeParse(c.req.query());
    if (!paging.success) {
      return adminError(
        c,
        400,
        "validation_error",
        paging.error.issues[0]?.message ?? "Invalid query",
      );
    }
    return c.json(
      await listSessions({
        filters: filters.data,
        page: paging.data.page,
        pageSize: paging.data.page_size,
        sort: paging.data.sort as (typeof SESSION_SORT_KEYS)[number],
        direction: paging.data.dir,
      }),
    );
  });

  /** Bulk export with the list's filters, or an explicit `ids=a,b` selection. Streamed. */
  app.get("/export", (c) => {
    const filters = parseFilters(c);
    if ("response" in filters) return filters.response;
    const query = exportQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return adminError(
        c,
        400,
        "validation_error",
        query.error.issues[0]?.message ?? "Invalid query",
      );
    }
    let selection: Parameters<typeof streamSessionsExport>[0] = { filters: filters.data };
    if (query.data.ids) {
      const ids = query.data.ids.split(",").filter(Boolean);
      if (!ids.every((id) => z.uuid().safeParse(id).success)) {
        return adminError(c, 400, "validation_error", "ids must be UUIDs");
      }
      selection = { ids };
    }
    const stream = streamSessionsExport(selection, query.data.format);
    return query.data.format === "csv"
      ? download(stream, "text/csv; charset=utf-8", "sessions.csv")
      : download(stream, "application/json", "sessions.json");
  });

  app.post("/bulk-delete", async (c) => {
    const parsed = await parseBody(c, sessionBulkDeleteSchema);
    if ("response" in parsed) return parsed.response;
    const selection = parsed.data.ids
      ? { ids: parsed.data.ids }
      : { filters: parsed.data.filters ?? {} };
    return c.json({ deleted: await deleteSessionsBySelection(selection) });
  });

  /** Runs the sweeper and retention purge now (the scheduler does the same on a timer). */
  app.post("/maintenance", async (c) => c.json(await runMaintenance()));

  app.get("/:id", async (c) => {
    try {
      return c.json(await getSessionDetail(c.req.param("id")));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.get("/:id/export", async (c) => {
    const format = c.req.query("format") === "md" ? "md" : "json";
    try {
      const detail = await getSessionDetail(c.req.param("id"));
      return format === "md"
        ? download(
            renderSessionMarkdown(detail),
            "text/markdown; charset=utf-8",
            `session-${detail.id}.md`,
          )
        : download(
            JSON.stringify(detail, null, 2),
            "application/json",
            `session-${detail.id}.json`,
          );
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.post("/:id/end", async (c) => {
    try {
      await endSession(c.req.param("id"));
      return c.json(await getSessionDetail(c.req.param("id")));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.delete("/:id", async (c) => {
    try {
      await deleteSession(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  return app;
}

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  flowCreateSchema,
  flowDraftSchema,
  flowPublishSchema,
  flowTestRunSchema,
  flowUpdateSchema,
} from "@/lib/agent-schemas";
import type { AgentTestEvent, FlowDetail } from "@/lib/agents/types";
import { createInMemoryMemoryStore } from "@/server/agents/memory";
import { runAgent } from "@/server/agents/runtime";
import { adminError, handleServiceError, parseBody } from "@/server/api/admin/helpers";
import { formatSseEvent } from "@/server/gateway/sse";
import {
  createFlow,
  deleteFlow,
  duplicateFlow,
  getFlow,
  getVersion,
  listFlows,
  listVersions,
  publishFlow,
  restoreVersion,
  saveDraft,
  updateFlow,
  validateFlowDraft,
} from "@/server/services/agents";
import { type ResolvedRoute, resolveRoute } from "@/server/services/routes";

function versionParam(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function testRoute(defaultSlug: string | null): Promise<ResolvedRoute | undefined> {
  if (defaultSlug) {
    const route = await resolveRoute({ kind: "slug", slug: defaultSlug });
    if (route) return route;
  }
  return resolveRoute({ kind: "default" });
}

export function createFlowsApp(): Hono {
  const app = new Hono();

  app.get("/", async (c) => c.json({ data: await listFlows() }));

  app.post("/", async (c) => {
    const parsed = await parseBody(c, flowCreateSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(await createFlow(parsed.data), 201);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.get("/:id", async (c) => {
    try {
      return c.json(await getFlow(c.req.param("id")));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.patch("/:id", async (c) => {
    const parsed = await parseBody(c, flowUpdateSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(await updateFlow(c.req.param("id"), parsed.data));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.delete("/:id", async (c) => {
    try {
      await deleteFlow(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.post("/:id/duplicate", async (c) => {
    try {
      return c.json(await duplicateFlow(c.req.param("id")), 201);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  /** Autosave. Last save wins; `conflict` warns that another save landed after the client's copy. */
  app.put("/:id/draft", async (c) => {
    const parsed = await parseBody(c, flowDraftSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(
        await saveDraft(c.req.param("id"), parsed.data.graph, parsed.data.base_draft_updated_at),
      );
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.get("/:id/validate", async (c) => {
    try {
      return c.json(await validateFlowDraft(c.req.param("id")));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.post("/:id/publish", async (c) => {
    const parsed = await parseBody(c, flowPublishSchema);
    if ("response" in parsed) return parsed.response;
    try {
      const published = await publishFlow(c.req.param("id"), parsed.data.note);
      return c.json({ ...published, flow: await getFlow(c.req.param("id")) }, 201);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.get("/:id/versions", async (c) => {
    try {
      return c.json({ data: await listVersions(c.req.param("id")) });
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.get("/:id/versions/:version", async (c) => {
    const version = versionParam(c.req.param("version"));
    if (version === undefined) return adminError(c, 400, "validation_error", "Invalid version");
    try {
      return c.json(await getVersion(c.req.param("id"), version));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.post("/:id/versions/:version/restore", async (c) => {
    const version = versionParam(c.req.param("version"));
    if (version === undefined) return adminError(c, 400, "validation_error", "Invalid version");
    try {
      return c.json(await restoreVersion(c.req.param("id"), version));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  /**
   * Runs the draft without publishing. JSON returns `{reply, trace}`; `stream: true` emits
   * `node_start`, `node_end`, `text`, `done` (or `error`) SSE events for the test drawer.
   */
  app.post("/:id/test-run", async (c) => {
    const parsed = await parseBody(c, flowTestRunSchema);
    if ("response" in parsed) return parsed.response;
    let flow: FlowDetail;
    try {
      flow = await getFlow(c.req.param("id"));
    } catch (error) {
      return handleServiceError(c, error);
    }
    const validation = await validateFlowDraft(flow.id);
    if (!validation.valid) {
      return c.json(
        {
          error: {
            code: "flow_invalid",
            message: "Fix the problems before testing",
            details: validation.problems,
          },
        },
        400,
      );
    }
    const route = await testRoute(flow.settings.default_route_slug);
    const messages = [{ role: "user", content: parsed.data.input }];
    const common = {
      flowId: flow.id,
      version: flow.published_version ?? 0,
      graph: flow.draft,
      sessionId: `test-${randomUUID()}`,
      messages,
      inputText: parsed.data.input,
      route,
      signal: c.req.raw.signal,
      deps: { memory: createInMemoryMemoryStore() },
    };

    if (!parsed.data.stream) {
      const result = await runAgent(common);
      return c.json({
        reply: result.reply,
        status: result.status,
        error: result.error,
        trace: result.trace,
      });
    }

    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const send = (event: AgentTestEvent) => {
      void writer.write(encoder.encode(formatSseEvent(event.type, JSON.stringify(event))));
    };
    void runAgent({
      ...common,
      onEvent: (event) => {
        switch (event.type) {
          case "node_start":
            send({
              type: "node_start",
              node_id: event.nodeId ?? "",
              node_type: event.nodeType ?? "",
              title: event.title ?? "",
            });
            break;
          case "node_end":
            send({
              type: "node_end",
              node_id: event.nodeId ?? "",
              status: event.status ?? "ok",
              duration_ms: event.durationMs ?? 0,
              error: event.error,
            });
            break;
          case "text":
            if (event.delta) send({ type: "text", delta: event.delta });
            break;
          case "done":
            if (event.trace) send({ type: "done", reply: event.reply ?? "", trace: event.trace });
            break;
        }
      },
    })
      .then(() => writer.close().catch(() => {}))
      .catch((error: unknown) => {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "Test run failed",
        });
        void writer.close().catch(() => {});
      });

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  });

  return app;
}

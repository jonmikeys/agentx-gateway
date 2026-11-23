import { type Context, Hono } from "hono";
import {
  mcpServerCreateSchema,
  mcpServerUpdateSchema,
  mcpToolAllowedSchema,
} from "@/lib/gateway-schemas";
import { handleServiceError, parseBody } from "@/server/api/admin/helpers";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listAllowedMcpTools,
  listMcpServers,
  listMcpTools,
  refreshMcpTools,
  setMcpToolAllowed,
  testMcpServer,
  updateMcpServer,
} from "@/server/services/mcp";

export function createMcpServersApp(): Hono {
  const app = new Hono();

  app.get("/", async (c) => c.json({ data: await listMcpServers() }));

  app.post("/", async (c) => {
    const parsed = await parseBody(c, mcpServerCreateSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(await createMcpServer(parsed.data), 201);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.get("/:id", async (c) => {
    try {
      return c.json(await getMcpServer(c.req.param("id")));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  const update = async (c: Context) => {
    const parsed = await parseBody(c, mcpServerUpdateSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(await updateMcpServer(c.req.param("id") ?? "", parsed.data));
    } catch (error) {
      return handleServiceError(c, error);
    }
  };
  app.patch("/:id", update);
  app.put("/:id", update);

  app.delete("/:id", async (c) => {
    try {
      await deleteMcpServer(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.post("/:id/test", async (c) => {
    try {
      return c.json(await testMcpServer(c.req.param("id")));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.post("/:id/refresh-tools", async (c) => {
    try {
      return c.json({ data: await refreshMcpTools(c.req.param("id")) });
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.get("/:id/tools", async (c) => {
    try {
      return c.json({ data: await listMcpTools(c.req.param("id")) });
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  return app;
}

/** Tools browser across servers; `?allowed=true` is what the route editor picker needs. */
export function createMcpToolsApp(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const allowedOnly = c.req.query("allowed") === "true";
    return c.json({ data: allowedOnly ? await listAllowedMcpTools() : await listMcpTools() });
  });

  app.patch("/:id", async (c) => {
    const parsed = await parseBody(c, mcpToolAllowedSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(await setMcpToolAllowed(c.req.param("id"), parsed.data.allowed));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  return app;
}

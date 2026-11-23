import { type Context, Hono } from "hono";
import { routeWriteSchema } from "@/lib/gateway-schemas";
import { handleServiceError, parseBody } from "@/server/api/admin/helpers";
import {
  createRoute,
  deleteRoute,
  getRoute,
  listRoutes,
  setDefaultRoute,
  updateRoute,
} from "@/server/services/routes";

export function createRoutesApp(): Hono {
  const app = new Hono();

  app.get("/", async (c) => c.json({ data: await listRoutes() }));

  app.post("/", async (c) => {
    const parsed = await parseBody(c, routeWriteSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(await createRoute(parsed.data), 201);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.get("/:id", async (c) => {
    try {
      return c.json(await getRoute(c.req.param("id")));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  // Replaces the route's fields and its ordered steps array.
  const update = async (c: Context) => {
    const parsed = await parseBody(c, routeWriteSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(await updateRoute(c.req.param("id") ?? "", parsed.data));
    } catch (error) {
      return handleServiceError(c, error);
    }
  };
  app.put("/:id", update);
  app.patch("/:id", update);

  app.post("/:id/default", async (c) => {
    try {
      return c.json(await setDefaultRoute(c.req.param("id")));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.delete("/:id", async (c) => {
    try {
      await deleteRoute(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  return app;
}

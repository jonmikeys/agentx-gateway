import { type Context, Hono } from "hono";
import { providerCreateSchema, providerUpdateSchema } from "@/lib/gateway-schemas";
import { handleServiceError, parseBody } from "@/server/api/admin/helpers";
import { testProviderConnection } from "@/server/gateway/provider-test";
import {
  createProvider,
  deleteProvider,
  getProvider,
  getProviderRuntime,
  listProviders,
  updateProvider,
} from "@/server/services/providers";

export function createProvidersApp(): Hono {
  const app = new Hono();

  app.get("/", async (c) => c.json({ data: await listProviders() }));

  app.post("/", async (c) => {
    const parsed = await parseBody(c, providerCreateSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(await createProvider(parsed.data), 201);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.get("/:id", async (c) => {
    try {
      return c.json(await getProvider(c.req.param("id")));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  const update = async (c: Context) => {
    const parsed = await parseBody(c, providerUpdateSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(await updateProvider(c.req.param("id") ?? "", parsed.data));
    } catch (error) {
      return handleServiceError(c, error);
    }
  };
  app.patch("/:id", update);
  app.put("/:id", update);

  app.delete("/:id", async (c) => {
    try {
      await deleteProvider(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.post("/:id/test", async (c) => {
    try {
      const provider = await getProviderRuntime(c.req.param("id"));
      return c.json(await testProviderConnection(provider));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  return app;
}

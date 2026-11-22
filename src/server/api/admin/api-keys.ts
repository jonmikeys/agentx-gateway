import { type Context, Hono } from "hono";
import { apiKeyCreateSchema, apiKeyUpdateSchema } from "@/lib/gateway-schemas";
import { handleServiceError, parseBody } from "@/server/api/admin/helpers";
import { createApiKey, listApiKeys, revokeApiKey, updateApiKey } from "@/server/services/api-keys";

export function createApiKeysApp(): Hono {
  const app = new Hono();

  app.get("/", async (c) => c.json({ data: await listApiKeys() }));

  /** The only response that ever contains the plaintext key. */
  app.post("/", async (c) => {
    const parsed = await parseBody(c, apiKeyCreateSchema);
    if ("response" in parsed) return parsed.response;
    const { key, apiKey } = await createApiKey(parsed.data);
    c.header("Cache-Control", "no-store");
    return c.json({ ...apiKey, key }, 201);
  });

  const update = async (c: Context) => {
    const parsed = await parseBody(c, apiKeyUpdateSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(await updateApiKey(c.req.param("id") ?? "", parsed.data));
    } catch (error) {
      return handleServiceError(c, error);
    }
  };
  app.patch("/:id", update);
  app.put("/:id", update);

  app.post("/:id/revoke", async (c) => {
    try {
      return c.json(await revokeApiKey(c.req.param("id")));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  return app;
}

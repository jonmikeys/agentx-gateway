import { Hono } from "hono";
import { sessionSettingsSchema } from "@/lib/gateway-schemas";
import { parseBody } from "@/server/api/admin/helpers";
import { getSessionSettings, updateSessionSettings } from "@/server/services/session-settings";

export function createSettingsApp(): Hono {
  const app = new Hono();
  app.get("/", async (c) => c.json(await getSessionSettings()));
  app.put("/", async (c) => {
    const parsed = await parseBody(c, sessionSettingsSchema);
    if ("response" in parsed) return parsed.response;
    return c.json(await updateSessionSettings(parsed.data));
  });
  return app;
}

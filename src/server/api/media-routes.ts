import type { Hono } from "hono";
import { openAIError } from "@/server/api/errors";
import { getEnv } from "@/server/env";
import type { ClientEnv } from "@/server/gateway/client-auth";
import { resolvePublicBaseUrl } from "@/server/media/public-url";
import { serveMedia } from "@/server/media/serve";
import { getMediaStorage } from "@/server/media/storage";
import { listEnabledCameras, toCameraCatalogueEntry } from "@/server/services/cameras";
import { findMedia, listEnabledMedia, toCatalogueEntry } from "@/server/services/media";

/** Registers the authenticated media and camera catalogue routes (`/v1/media`, `/v1/cameras`). */
export function registerMediaRoutes(app: Hono<ClientEnv>): void {
  app.get("/v1/media", async (c) => {
    const baseUrl = resolvePublicBaseUrl(c.req.url, c.req.raw.headers, getEnv().PUBLIC_BASE_URL);
    const rows = await listEnabledMedia();
    return c.json({ object: "list", data: rows.map((row) => toCatalogueEntry(row, baseUrl)) });
  });

  app.get("/v1/media/:id/content", async (c) => {
    const row = await findMedia(c.req.param("id"));
    // Disabled items are invisible to clients, exactly like unknown ids. The code is
    // `media_not_found` (never `session_not_found`, which Unity treats as session expiry).
    if (!row?.enabled) {
      return openAIError(404, "media_not_found", `No media item ${c.req.param("id")}.`);
    }
    return serveMedia(c.req.raw, row, getMediaStorage());
  });

  app.get("/v1/cameras", async (c) => {
    const rows = await listEnabledCameras();
    c.header("Cache-Control", "no-store");
    return c.json({ object: "list", data: rows.map(toCameraCatalogueEntry) });
  });
}

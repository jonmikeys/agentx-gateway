import { type Context, Hono } from "hono";
import {
  mediaExternalCreateSchema,
  mediaQuerySchema,
  mediaUpdateSchema,
} from "@/lib/media-schemas";
import { adminError, handleServiceError, parseBody } from "@/server/api/admin/helpers";
import { openAIError } from "@/server/api/errors";
import { serveMedia } from "@/server/media/serve";
import { getMediaStorage } from "@/server/media/storage";
import {
  createExternalMedia,
  createUploadedMedia,
  deleteMedia,
  findMedia,
  listMedia,
  listMediaTags,
  toMediaView,
  updateMedia,
} from "@/server/services/media";

export function createMediaApp(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const query = mediaQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return adminError(c, 400, "validation_error", query.error.issues[0]?.message ?? "Bad filter");
    }
    const [rows, tags] = await Promise.all([listMedia(query.data), listMediaTags()]);
    return c.json({ data: rows.map(toMediaView), tags });
  });

  /**
   * Multipart upload: text fields (`name`, `description`, `tags`, `enabled`) first, then the
   * `file` part. The proxy does not buffer this route (see `src/proxy.ts`).
   */
  app.post("/upload", async (c) => {
    try {
      return c.json(toMediaView(await createUploadedMedia(c.req.raw)), 201);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.post("/", async (c) => {
    const parsed = await parseBody(c, mediaExternalCreateSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(toMediaView(await createExternalMedia(parsed.data)), 201);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.get("/:id", async (c) => {
    const row = await findMedia(c.req.param("id"));
    if (!row) return adminError(c, 404, "media_not_found", "Media item not found");
    return c.json(toMediaView(row));
  });

  /** CRM previews: same bytes as `/v1/media/:id/content`, behind admin auth. */
  app.get("/:id/content", async (c) => {
    const row = await findMedia(c.req.param("id"));
    if (!row) return openAIError(404, "media_not_found", "Media item not found");
    return serveMedia(c.req.raw, row, getMediaStorage());
  });

  const update = async (c: Context) => {
    const parsed = await parseBody(c, mediaUpdateSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(toMediaView(await updateMedia(c.req.param("id") ?? "", parsed.data)));
    } catch (error) {
      return handleServiceError(c, error);
    }
  };
  app.patch("/:id", update);
  app.put("/:id", update);

  app.delete("/:id", async (c) => {
    try {
      await deleteMedia(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  return app;
}

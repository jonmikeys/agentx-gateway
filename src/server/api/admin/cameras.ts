import { type Context, Hono } from "hono";
import { cameraInputSchema, cameraReorderSchema, cameraUpdateSchema } from "@/lib/media-schemas";
import { adminError, handleServiceError, parseBody } from "@/server/api/admin/helpers";
import { logger } from "@/server/logger";
import { openMjpegStream, testMjpegStream } from "@/server/media/mjpeg";
import {
  createCamera,
  deleteCamera,
  getCameraRuntime,
  listCameras,
  reorderCameras,
  toCameraView,
  updateCamera,
} from "@/server/services/cameras";
import { ServiceError } from "@/server/services/errors";

export function createCamerasApp(): Hono {
  const app = new Hono();

  app.get("/", async (c) => c.json({ data: (await listCameras()).map(toCameraView) }));

  app.post("/", async (c) => {
    const parsed = await parseBody(c, cameraInputSchema);
    if ("response" in parsed) return parsed.response;
    return c.json(toCameraView(await createCamera(parsed.data)), 201);
  });

  app.post("/reorder", async (c) => {
    const parsed = await parseBody(c, cameraReorderSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json({ data: (await reorderCameras(parsed.data.ids)).map(toCameraView) });
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  app.get("/:id", async (c) => {
    try {
      return c.json(toCameraView((await getCameraRuntime(c.req.param("id"))).row));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  const update = async (c: Context) => {
    const parsed = await parseBody(c, cameraUpdateSchema);
    if ("response" in parsed) return parsed.response;
    try {
      return c.json(toCameraView(await updateCamera(c.req.param("id") ?? "", parsed.data)));
    } catch (error) {
      return handleServiceError(c, error);
    }
  };
  app.patch("/:id", update);
  app.put("/:id", update);

  app.delete("/:id", async (c) => {
    try {
      await deleteCamera(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  /** Checks that an `mjpeg_url` camera streams multipart/x-mixed-replace and sends a frame. */
  app.post("/:id/test", async (c) => {
    try {
      const camera = await getCameraRuntime(c.req.param("id"));
      if (camera.row.type !== "mjpeg_url" || !camera.url) {
        return adminError(
          c,
          400,
          "test_unsupported",
          `Connection tests are not available for ${camera.row.type} cameras`,
        );
      }
      return c.json(await testMjpegStream(camera.url, camera.credentials));
    } catch (error) {
      return handleServiceError(c, error);
    }
  });

  /**
   * Admin-only MJPEG proxy for the CRM preview, so the browser needs neither the camera
   * credentials nor CORS. Unity connects to cameras directly and never uses this route.
   */
  app.get("/:id/preview", async (c) => {
    try {
      const camera = await getCameraRuntime(c.req.param("id"));
      if (camera.row.type !== "mjpeg_url" || !camera.url) {
        return adminError(
          c,
          400,
          "preview_unsupported",
          `Preview is not available for ${camera.row.type} cameras`,
        );
      }
      const upstream = await openMjpegStream(camera.url, camera.credentials, c.req.raw.signal);
      const contentType = upstream.headers.get("content-type") ?? "";
      if (!upstream.ok || !contentType.toLowerCase().includes("multipart/x-mixed-replace")) {
        await upstream.body?.cancel().catch(() => undefined);
        return c.json(
          {
            error: {
              code: "camera_unavailable",
              message: upstream.ok
                ? "The camera did not return an MJPEG stream"
                : `The camera answered HTTP ${upstream.status}`,
            },
          },
          502,
        );
      }
      return new Response(upstream.body, {
        status: 200,
        headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (error instanceof ServiceError) return handleServiceError(c, error);
      logger.warn("Camera preview failed", {
        camera_id: c.req.param("id"),
        error: error instanceof Error ? error.name : "unknown",
      });
      return c.json(
        { error: { code: "camera_unavailable", message: "Could not connect to the camera" } },
        502,
      );
    }
  });

  return app;
}

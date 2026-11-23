import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { registerClientRoutes } from "@/server/api/client-routes";
import { openAIError } from "@/server/api/errors";
import { registerMediaRoutes } from "@/server/api/media-routes";
import { buildOpenApiDocument, OPENAPI_PATH } from "@/server/api/openapi";
import { pingDatabase } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { type ClientEnv, clientAuth } from "@/server/gateway/client-auth";
import { logger } from "@/server/logger";
import { resolvePublicBaseUrl } from "@/server/media/public-url";
import packageJson from "../../../package.json";

export const API_VERSION: string = packageJson.version;

/** Client-facing API (`/v1/*`, `/agents`, `/health`). All routes use full paths. */
export interface ApiAppOptions {
  /** Overrides Bearer API key auth (tests only). */
  clientAuth?: MiddlewareHandler<ClientEnv>;
}

export function createApiApp(options: ApiAppOptions = {}): Hono<ClientEnv> {
  const app = new Hono<ClientEnv>();

  const clientCors = cors({
    origin: "*",
    allowHeaders: ["Authorization", "X-Session-Id", "Content-Type", "Range"],
    allowMethods: ["GET", "HEAD", "POST", "OPTIONS"],
    exposeHeaders: ["X-Session-Id", "Content-Range", "Accept-Ranges", "Content-Length", "ETag"],
    maxAge: 600,
  });
  app.use("/v1/*", clientCors);
  app.use("/agents", clientCors);

  const auth = options.clientAuth ?? clientAuth;
  // The OpenAPI document is public (like /health) so tools and the /docs reference can load it.
  app.use("/v1/*", (c, next) =>
    new URL(c.req.url).pathname === OPENAPI_PATH ? next() : auth(c, next),
  );
  app.use("/agents", auth);
  app.use("/agents/*", auth);

  app.get("/health", async (c) => {
    const db = await pingDatabase();
    return c.json({ ok: db, db, version: API_VERSION }, db ? 200 : 503);
  });

  app.get(OPENAPI_PATH, (c) => {
    const serverUrl = resolvePublicBaseUrl(c.req.url, c.req.raw.headers, getEnv().PUBLIC_BASE_URL);
    return c.json(buildOpenApiDocument({ version: API_VERSION, serverUrl }));
  });

  registerClientRoutes(app);
  registerMediaRoutes(app);
  // New client routes must also be documented in `openapi.ts` (tests/unit/openapi.test.ts).

  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/v1/") || path === "/v1" || path.startsWith("/agents")) {
      // 404 is reserved for `session_not_found` on chat routes, so use `not_found` here.
      return openAIError(404, "not_found", `Unknown route: ${c.req.method} ${path}`);
    }
    return c.json({ error: "not_found" }, 404);
  });

  app.onError((error, c) => {
    logger.error("Unhandled API error", { error: error.name, path: new URL(c.req.url).pathname });
    return openAIError(500, "internal_error", "Internal server error", "server_error");
  });

  return app;
}

export const app = createApiApp();

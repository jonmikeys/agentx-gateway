import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { registerClientRoutes } from "@/server/api/client-routes";
import { openAIError } from "@/server/api/errors";
import { pingDatabase } from "@/server/db/client";
import { type ClientEnv, clientAuth } from "@/server/gateway/client-auth";
import { logger } from "@/server/logger";
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
    allowHeaders: ["Authorization", "X-Session-Id", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    exposeHeaders: ["X-Session-Id"],
    maxAge: 600,
  });
  app.use("/v1/*", clientCors);
  app.use("/agents", clientCors);

  const auth = options.clientAuth ?? clientAuth;
  app.use("/v1/*", auth);
  app.use("/agents", auth);
  app.use("/agents/*", auth);

  app.get("/health", async (c) => {
    const db = await pingDatabase();
    return c.json({ ok: db, db, version: API_VERSION }, db ? 200 : 503);
  });

  registerClientRoutes(app);
  // Later stages register /v1/responses, /agents, ... here.

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

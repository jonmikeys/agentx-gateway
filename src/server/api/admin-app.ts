import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { createApiKeysApp } from "@/server/api/admin/api-keys";
import { createCamerasApp } from "@/server/api/admin/cameras";
import { createDashboardApp } from "@/server/api/admin/dashboard";
import { createMediaApp } from "@/server/api/admin/media";
import { createProvidersApp } from "@/server/api/admin/providers";
import { createRoutesApp } from "@/server/api/admin/routes";
import { createSessionsApp } from "@/server/api/admin/sessions";
import { createSettingsApp } from "@/server/api/admin/settings";
import { guardAdminRequest } from "@/server/auth/admin-auth";

type AdminEnv = { Variables: { adminUsername: string } };

/** Hono middleware that requires AdminAuth (defence in depth; the proxy also guards `/api/admin/*`). */
export const requireAdmin = createMiddleware<AdminEnv>(async (c, next) => {
  const result = await guardAdminRequest(c.req.raw);
  if ("response" in result) return result.response;
  c.set("adminUsername", result.username);
  await next();
});

/** Admin API served under `/api/admin/*`. Providers, routes and API keys CRUD (G2); later stages add more. */
export function createAdminApp(): Hono<AdminEnv> {
  const admin = new Hono<AdminEnv>();
  admin.use("/api/admin/*", requireAdmin);

  admin.get("/api/admin/me", (c) => c.json({ username: c.get("adminUsername") }));

  admin.route("/api/admin/providers", createProvidersApp());
  admin.route("/api/admin/routes", createRoutesApp());
  admin.route("/api/admin/api-keys", createApiKeysApp());
  admin.route("/api/admin/sessions", createSessionsApp());
  admin.route("/api/admin/settings", createSettingsApp());
  admin.route("/api/admin/dashboard", createDashboardApp());
  admin.route("/api/admin/media", createMediaApp());
  admin.route("/api/admin/cameras", createCamerasApp());

  admin.notFound((c) =>
    c.json({ error: { code: "not_found", message: "Unknown admin route" } }, 404),
  );
  return admin;
}

export const adminApp = createAdminApp();

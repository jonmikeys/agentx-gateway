import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { guardAdminRequest } from "@/server/auth/admin-auth";

type AdminEnv = { Variables: { adminUsername: string } };

/** Hono middleware that requires AdminAuth (defence in depth; the proxy also guards `/api/admin/*`). */
export const requireAdmin = createMiddleware<AdminEnv>(async (c, next) => {
  const result = await guardAdminRequest(c.req.raw);
  if ("response" in result) return result.response;
  c.set("adminUsername", result.username);
  await next();
});

/** Admin API served under `/api/admin/*`. Later stages add CRM CRUD endpoints here. */
export function createAdminApp(): Hono<AdminEnv> {
  const admin = new Hono<AdminEnv>();
  admin.use("/api/admin/*", requireAdmin);

  admin.get("/api/admin/me", (c) => c.json({ username: c.get("adminUsername") }));

  admin.notFound((c) =>
    c.json({ error: { code: "not_found", message: "Unknown admin route" } }, 404),
  );
  return admin;
}

export const adminApp = createAdminApp();
